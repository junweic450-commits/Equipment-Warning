"""本地规则分析引擎：把风险模拟结果翻译成结论、归因和可行方案。

设计约束：
    * 不联网、不调模型，只消费 dashboard._state() 已有的字段。同一份数据
      永远得到同一份结论，可解释、可复现、离线可用。
    * 数值口径全部复用 dashboard 的现算结果：模型分 raw_risk、工况分
      cond_risk、合成 risk = 1 - (1-raw)(1-cond)，这里不另起一套算法。
    * 云知声 Agent 只做追问问答和补充建议，不参与本文件任何判级。

可加分解（无重叠，三项相加正好等于综合分）：
    risk = raw + cond - raw*cond
         = raw*(1-cond) + cond*(1-raw) + raw*cond
           模型独立贡献    工况独立贡献    两路叠加

工况侧的"如果……会降多少"是可以精确算的：工况分是 7 项加权求和，改一项
权重输入就能重算，所以行动清单里带真实的风险下降幅度。模型侧要跑 sklearn，
本文件不碰（保持零依赖），只在文案里说明"模型侧通常同步受益、此处未重算"。
"""

import math
from datetime import datetime, timedelta

# 检修排期的时限（天）：以看板 ts 那天为起点往后推。
# "下次检修" 不写死 45 天，而是用台账里的「计划检修频率（次/季）」倒推每台到期日，
# 45 只在遥测或填报缺失时兜底，保证这一档永远有日期可显示。
PLAN_DAYS = {"这几天": 3, "两周内": 14, "下次检修": 45}

# 分级 → 排期窗口。全局分档、单台解读的「什么时候处理」、CSV 导出共用这三张表，
# 免得同一个口径写在三处，改一处漏一处。「正常」级不进排期。
LEVEL_WINDOW = {"red": "这几天", "orange": "两周内", "yellow": "下次检修", "gray": "先补数据"}
WINDOW_TAIL = {"这几天": "建议本周内停机检查。", "两周内": "建议两周内安排检修。",
               "下次检修": "不紧急，下次检修一起处理。", "先补数据": "先补数据再判断。"}
WINDOW_REASON = {"这几天": "报警级，随时可能出故障", "两周内": "预警级，赶下个检修窗口前处理掉",
                 "下次检修": "关注级，跟计划检修一起办",
                 "先补数据": "没有运行数据，算不出风险，先把数据接上"}

# 分级阈值：来自排水设备现场经验口径，集中放这里便于和工艺人员一起校订
TH = {
    "load_ratio_high": 1.10,     # 电流 / 额定电流
    "load_ratio_mid": 0.95,
    "rise_high": 45.0,           # 温升 = 设备温度 - 环境温度（K）
    "rise_mid": 30.0,
    "dev_temp_high": 80.0,       # 绝对温度（℃）
    "dev_temp_mid": 70.0,
    "humidity_high": 2.5,        # 遥测湿度是 1~3 连续量，不是整数档
    "humidity_mid": 2.0,
    "dust_high": 2.5,
    "dust_mid": 2.0,
    "run_hours_high": 10000.0,
    "run_hours_mid": 7000.0,
    "since_repair_high": 2000.0,
    "since_repair_mid": 1000.0,
    "env_temp_high": 30.0,       # 巷道基准温度
    "env_temp_mid": 27.0,
}

PRIORITY_ORDER = {"高": 0, "中": 1, "低": 2}


def _num(value):
    """能转成有限浮点数就返回，否则 None（None/空串/NaN/inf 一律当缺数据）。"""
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _as_of(state):
    """分析基准日：取看板自己那份 ts（不是本机当前时间），同一份数据出同一份日期。"""
    ts = (state or {}).get("ts") or ""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(ts[:19] if len(ts) >= 19 else ts, fmt).date()
        except (ValueError, TypeError):
            continue
    return datetime.now().date()


def _cn_date(day):
    return "%d月%d日" % (day.month, day.day)


def _date_range(start, end):
    if start == end:
        return _cn_date(start)
    return "%s—%s" % (_cn_date(start), _cn_date(end))


def _next_repair_date(device, base):
    """按台账口径倒推下次检修到期日：
       上次检修 ≈ 基准日 - 距上次检修小时数；间隔 ≈ 90 天 ÷（次/季）。
       dashboard 算「检修频率不足」这一项用的就是同一个 plan_maintain，口径一致。"""
    tel = (device or {}).get("telemetry") or {}
    since = _num(tel.get("since_repair_hours"))
    per_quarter = _num(((device or {}).get("calib") or {}).get("plan_maintain"))
    if since is None or per_quarter is None or per_quarter <= 0:
        return None
    last = base - timedelta(days=since / 24.0)
    return last + timedelta(days=90.0 / per_quarter)


def _plan_for(device, level_key, base):
    """单台的排期结论：落在哪个窗口、哪天到期、给用户看的那句话。

    「下次检修」这一档不写死 45 天，用台账里的计划检修频率倒推每台自己的到期日，
    和 analyze_global 的排期表同一口径；缺遥测或没填频率时退回通用文案，不编日期。
    """
    window = LEVEL_WINDOW.get(level_key)
    if not window:
        return {"window": "", "due": "", "dates": "", "overdue": 0,
                "tail": "按正常巡检走就行。"}
    out = {"window": window, "due": "", "dates": "", "overdue": 0,
           "tail": WINDOW_TAIL[window]}
    if window == "下次检修":
        due = _next_repair_date(device, base)
        if due:
            out["due"] = due.isoformat()
            # dates 是给人看的期限：和排期表一样不把"昨天"写在期限位上，逾期由 overdue 说明
            out["dates"] = _cn_date(max(due, base))
            out["overdue"] = 1 if due < base else 0
            out["tail"] = ("不紧急，但按台账倒推检修期已经过了（原计划 %s），这轮一起补上。" % _cn_date(due)
                           if out["overdue"] else
                           "不紧急，下次检修一起处理（预计 %s 到期）。" % _cn_date(due))
    return out


def _fmt_val(value):
    """台账/校准值既可能是 int 也可能是 float，展示时统一：整数不带小数点。"""
    number = _num(value)
    if number is None:
        return "—"
    return str(int(number)) if number.is_integer() else ("%.1f" % number)


def _pct(value, digits=1):
    number = _num(value)
    return "—" if number is None else "%.*f%%" % (digits, number * 100)


def _split(raw, cond):
    """把综合分拆成模型独立 / 工况独立 / 两路叠加三段。"""
    raw = _num(raw)
    cond = _num(cond) or 0.0
    if raw is None:
        return None, cond, 0.0
    return raw * (1 - cond), cond * (1 - raw), raw * cond


def _verdict(value, high, mid, reverse=False):
    """reverse=True 表示数值越小越危险。"""
    if value is None:
        return None
    if reverse:
        if value <= high:
            return "高"
        return "中" if value <= mid else None
    if value >= high:
        return "高"
    return "中" if value >= mid else None


# --------------------------------------------------------------------------
# 现场口径：工况明细项 → 工人说的话
# --------------------------------------------------------------------------
# dashboard 的 cond_items.name 是数据契约（校准表、ITEM_FIELD 映射都用它），不能改；
# 这里只做一层展示名翻译，让分析和台账各说各的话、各用各的键。
PLAIN_ITEM = {
    "环境严酷度": "环境差",
    "湿度等级": "潮湿",
    "粉尘等级": "粉尘多",
    "淋水": "顶板淋水",
    "近三个月故障次数": "最近坏得多",
    "检修频率不足": "检修太少",
    "负载率超标": "超负荷",
}

# 综合风险的三个来源，现场叫法
PLAIN_DRIVER = {"model": "设备本身", "condition": "现场情况", "overlap": "两边叠加"}


def plain_item(name):
    return PLAIN_ITEM.get(name, name)


# --------------------------------------------------------------------------
# 单台：信号提取
# --------------------------------------------------------------------------
def _signals(device):
    """列出这台机器所有超标项，每项带实测值、阈值和结论，供前端直接渲染。

    标签用现场叫法，判据放 note 里。下游分支一律匹配 key，不匹配中文标签——
    否则改一个说法就会把 _actions 的判断全带偏。
    """
    tel = device.get("telemetry") or {}
    cal = device.get("calib") or {}
    out = []

    def add(key, label, value, unit, level, note, source):
        if level is None:
            return
        out.append({"key": key, "label": label,
                    "value": round(value, 2) if value is not None else None,
                    "unit": unit, "level": level, "note": note, "source": source})

    current = _num(tel.get("current"))
    rated_i = _num(device.get("rated_i"))
    if current is not None and rated_i and rated_i > 0:
        ratio = current / rated_i
        level = _verdict(ratio, TH["load_ratio_high"], TH["load_ratio_mid"])
        add("load", "电流超额定", ratio * 100, "%", level,
            "实测 %.1f A，额定 %.0f A" % (current, rated_i), "遥测")

    dev_temp = _num(tel.get("dev_temp"))
    env_temp = _num(tel.get("env_temp"))
    if dev_temp is not None:
        level = _verdict(dev_temp, TH["dev_temp_high"], TH["dev_temp_mid"])
        add("temp", "设备温度", dev_temp, "℃", level,
            "%g℃ 起要注意，%g℃ 算高" % (TH["dev_temp_mid"], TH["dev_temp_high"]), "遥测")
    if dev_temp is not None and env_temp is not None:
        rise = dev_temp - env_temp
        level = _verdict(rise, TH["rise_high"], TH["rise_mid"])
        add("rise", "比环境高出的温度", rise, "K", level,
            "设备 %.1f℃ − 环境 %.1f℃（高 %g K 起要注意）"
            % (dev_temp, env_temp, TH["rise_mid"]), "遥测")

    for key, label, high, mid, unit in (
            ("humidity", "潮湿", TH["humidity_high"], TH["humidity_mid"], "级"),
            ("dust", "粉尘", TH["dust_high"], TH["dust_mid"], "级")):
        value = _num(tel.get(key))
        add(key, label, value, unit, _verdict(value, high, mid),
            "现场 1~3 级，%g 级起注意、%g 级算高" % (mid, high), "遥测")

    run_hours = _num(tel.get("run_hours"))
    add("hours", "累计运行", run_hours, "h",
        _verdict(run_hours, TH["run_hours_high"], TH["run_hours_mid"]),
        "跑过 %g 小时该查易损件" % TH["run_hours_mid"], "遥测")

    since = _num(tel.get("since_repair_hours"))
    add("repair", "距上次检修", since, "h",
        _verdict(since, TH["since_repair_high"], TH["since_repair_mid"]),
        "超过 %g 小时没检修" % TH["since_repair_mid"], "遥测")

    if tel.get("fault_label") not in (None, "", 0, "0", False):
        out.append({"key": "fault_flag", "label": "标了故障", "value": None, "unit": "",
                    "level": "高", "note": "最新一条运行数据标的是故障", "source": "遥测"})

    # 工况填报侧（来源标记给现场看，写「现场填报」比「校准」直观）
    severity = _num(cal.get("env_severity"))
    add("severity", "环境恶劣程度", severity, "/5", _verdict(severity, 5, 4),
        "填到 4 档就开始拖风险", "现场填报")
    if int(cal.get("water_drip") or 0):
        add("drip", "顶板淋水", 1, "", "中", "有淋水就按满分算", "现场填报")
    faults = _num(cal.get("fault_count"))
    add("faults", "近三个月故障", faults, "次", _verdict(faults, 3, 2),
        "5 次封顶", "现场填报")
    maintain = _num(cal.get("plan_maintain"))
    add("maintain", "每季度检修次数", maintain, "次/季",
        _verdict(maintain, 1, 2, reverse=True), "少于 3 次/季就开始拖风险", "现场填报")
    load_rate = _num(cal.get("load_rate"))
    add("loadrate", "填报负荷", load_rate, "%", _verdict(load_rate, 100, 90),
        "超 80% 开始拖风险", "现场填报")

    out.sort(key=lambda s: PRIORITY_ORDER.get(s["level"], 9))
    return out


# --------------------------------------------------------------------------
# 单台：工况侧"改了会降多少"
# --------------------------------------------------------------------------
# 工况明细项（dashboard._condition_risk 里的 name）→ 校准字段
ITEM_FIELD = {
    "环境严酷度": "env_severity",
    "湿度等级": "humidity",
    "粉尘等级": "dust",
    "淋水": "water_drip",
    "检修频率不足": "plan_maintain",
    "负载率超标": "load_rate",
    # 近三个月故障次数是既成事实，改不了，只给定性建议
}

WHATIF = {
    "humidity": ("排积水、加通风，把潮湿降一级", lambda v: max(1, v - 1), "潮湿这一项占 22%"),
    "dust": ("开喷雾、清除尘，把粉尘降一级", lambda v: max(1, v - 1), "粉尘这一项占 16%"),
    "env_severity": ("隔离、降温、防腐，把环境降一档", lambda v: max(1, v - 1), "环境这一项占 18%"),
    "water_drip": ("打引水槽或封堵，把淋水消掉", lambda v: 0, "有淋水就按满分算，占 6%"),
    "plan_maintain": ("每季度多做一次计划检修", lambda v: min(12, v + 1), "检修太少这一项占 12%"),
    "load_rate": ("限载或分流，把负荷降下来", lambda v: max(50, v - 10), "负荷超 80% 的部分才扣分，占 6%"),
}


# 工况项输入值的单位：全局共性因素只展示"2 → 3"时容易被误读，补上口径
FIELD_UNIT = {"env_severity": "档", "humidity": "级", "dust": "级",
              "water_drip": "", "plan_maintain": "次/季", "load_rate": "%"}


def _whatif(device, hooks):
    """对贡献最大的工况项做闭环重算，给出真实的风险下降幅度。"""
    cal = device.get("calib") or {}
    cond_items = device.get("cond_items") or []
    raw = _num(device.get("raw_risk"))
    risk_now = _num(device.get("risk"))
    if risk_now is None or not hooks.get("condition_risk"):
        return []

    ranked = sorted(cond_items, key=lambda it: -float(it.get("contribution") or 0))
    results = []
    for item in ranked:
        field = ITEM_FIELD.get(item.get("name"))
        if field is None or float(item.get("contribution") or 0) <= 0.0001:
            continue
        current = _num(cal.get(field))
        if current is None:
            continue
        title, target_fn, basis = WHATIF[field]
        target = target_fn(current)
        if target == current:
            continue
        trial = dict(cal)
        trial[field] = target
        try:
            cond_after, _ = hooks["condition_risk"](trial)
            risk_after = (hooks["combine"](raw, cond_after)
                          if raw is not None else cond_after)
        except Exception:
            continue
        drop = max(risk_now - risk_after, 0.0)
        if drop < 0.0005:
            continue
        results.append({
            "title": title, "field": field, "item_name": item.get("name"),
            "from": current, "to": target,
            "show": "%s %s → %s %s" % (plain_item(item.get("name")), _fmt_val(current),
                                       _fmt_val(target), FIELD_UNIT.get(field, "")),
            "basis": basis, "cond_after": round(cond_after, 4),
            "risk_after": round(risk_after, 4), "drop": round(drop, 4),
            "expect": "%s → %s，能降 %.0f 个点"
                      % (_pct(risk_now), _pct(risk_after), drop * 100),
        })
        if len(results) >= 4:
            break
    results.sort(key=lambda r: -r["drop"])
    return results


# --------------------------------------------------------------------------
# 单台：行动清单
# --------------------------------------------------------------------------
def _actions(device, signals, whatif):
    level_key = (device.get("level") or {}).get("key", "gray")
    base = {"red": "高", "orange": "高", "yellow": "中", "green": "低", "gray": "中"}.get(level_key, "中")
    acts = []

    for w in whatif:
        acts.append({"priority": base if w["drop"] >= 0.03 else "中", "kind": "现场整改",
                     "title": w["title"],
                     "detail": "%s；%s" % (w["show"], w["basis"]),
                     "expect": w["expect"]})

    model_high = _num(device.get("raw_risk")) or 0
    if model_high >= 0.5:
        acts.append({"priority": "高", "kind": "设备本身", "title": "安排一次停机检查（振动、绝缘、轴承）",
                     "detail": "设备实测数据偏高 %s，主要是温度和电流抬上去的" % _pct(model_high),
                     "expect": "要停机测了才知道能降多少；现场环境先改好，这边通常跟着受益"})

    for sig in signals:
        if sig["source"] != "遥测" or sig["level"] not in ("高", "中"):
            continue
        urgent = "高" if sig["level"] == "高" else "中"
        if sig["key"] == "load":
            acts.append({"priority": urgent, "kind": "运行调整",
                         "title": "查回路和阀门开度，别长时间超负荷",
                         "detail": sig["note"], "expect": "电流回到额定以内，温度和负荷两边一起降"})
        elif sig["key"] in ("temp", "rise"):
            acts.append({"priority": urgent, "kind": "运行调整",
                         "title": "清散热风道、查冷却水路",
                         "detail": sig["note"], "expect": "温度下来，风险跟着下来"})
        elif sig["key"] == "fault_flag":
            acts.append({"priority": "高", "kind": "应急", "title": "按故障停机流程复核，能切就切备用泵",
                         "detail": sig["note"], "expect": "先去掉眼下最危险的一项"})
        elif sig["key"] in ("humidity", "dust"):
            acts.append({"priority": urgent if sig["key"] == "humidity" else "低",
                         "kind": "现场环境",
                         "title": "到现场确认%s（现在读数 %s%s）" % (sig["label"], sig["value"], sig["unit"]),
                         "detail": sig["note"],
                         "expect": "确认读数是不是传感器的问题，读数真高就先降一级"})
        elif sig["key"] in ("hours", "repair"):
            acts.append({"priority": "中" if sig["level"] == "高" else "低", "kind": "检修",
                         "title": "%s到点了（%s%s），安排人查" % (sig["label"], sig["value"], sig["unit"]),
                         "detail": sig["note"], "expect": "到点就查，别等坏了被动抢修"})

    if device.get("telemetry") is None:
        acts.append({"priority": base, "kind": "数据接入", "title": "给这台设备补运行数据",
                     "detail": "台账里有这台，但历史运行记录里没有它的实测数据",
                     "expect": "有了数据才算得出设备本身的风险，现在只按现场情况评级"})
    if device.get("error"):
        acts.append({"priority": "高", "kind": "异常", "title": "这条预测失败了，要人工看一眼",
                     "detail": device["error"], "expect": "修好之后风险值才会进看板统计"})

    # 同一句话可能由多个信号触发（比如设备温度和温升都指向散热），去重保留首条
    deduped = {}
    for act in acts:
        deduped.setdefault(act["title"], act)
    acts = list(deduped.values())
    acts.sort(key=lambda a: PRIORITY_ORDER.get(a["priority"], 9))
    return acts


# --------------------------------------------------------------------------
# 单台：主入口
# --------------------------------------------------------------------------
def analyze_device(device, hooks=None, state=None):
    """输入 _predict_all() 里的一条设备字典，输出结构化解读。

    state 可省略：只有「什么时候该检修」那句需要基准日，拿不到看板 ts 时退回本机今天。
    """
    hooks = hooks or {}
    raw = _num(device.get("raw_risk"))
    cond = _num(device.get("cond_risk"))
    risk = _num(device.get("risk"))
    level = device.get("level") or {}
    model_part, cond_part, overlap = _split(raw, cond)

    signals = _signals(device)
    whatif = _whatif(device, hooks)
    actions = _actions(device, signals, whatif)

    high = [s for s in signals if s["level"] == "高"]
    tel_high = [s for s in high if s["source"] == "遥测"]
    name = device.get("name") or device.get("code") or "该设备"
    level_name = level.get("name", "")

    # 抬升来源只认真正进了公式的项：设备本身、现场情况、以及现场情况里贡献最大的明细
    drivers = []
    if model_part and model_part > 0.005:
        drivers.append((PLAIN_DRIVER["model"], model_part))
    if cond_part and cond_part > 0.005:
        drivers.append((PLAIN_DRIVER["condition"], cond_part))
    if overlap and overlap > 0.005:
        drivers.append((PLAIN_DRIVER["overlap"], overlap))
    items = sorted(device.get("cond_items") or [],
                   key=lambda it: -float(it.get("contribution") or 0))
    top_items = [it for it in items if float(it.get("contribution") or 0) > 0.005][:2]

    plan = _plan_for(device, level.get("key", "gray"), _as_of(state))
    tail = plan["tail"]

    if risk is None:
        headline = "%s：没有风险数据。%s" % (name, "先补运行数据，或看预测是不是报错了。")
    else:
        headline = "%s：风险 %s，%s级。" % (name, _pct(risk, 2), "「%s」" % level_name if level_name else "")
        if drivers:
            headline += "主要是%s。" % "、".join(
                "%s占 %s" % (n, _pct(v, 1)) for n, v in drivers)
        else:
            headline += "设备本身和现场情况都不高。"
        if top_items:
            headline += "现场几项里最拖后腿的是%s。" % "、".join(
                "%s（%s）" % (plain_item(it["name"]), _pct(it["contribution"], 1)) for it in top_items)
        if raw == 0 and cond:
            headline += " 设备实测指标都正常，风险全部来自现场情况。"
        if tel_high:
            headline += " 还有 %d 项实测超标要复核：%s。" % (
                len(tel_high), "、".join(s["label"] for s in tel_high[:3]))
        if tail:
            headline += " " + tail

    if raw is None and cond is not None:
        attribution = "设备本身那一路没有数据（模型不可用或没有运行数据），风险全部按现场情况 %s 算。" % _pct(cond)
    else:
        named = [(PLAIN_DRIVER[key], val) for key, val in
                 (("model", model_part), ("condition", cond_part), ("overlap", overlap))
                 if val and val > 0.001]
        if len(named) == 1:
            attribution = "这 %s 全部来自%s，另一路不加分。" % (
                _pct(risk, 2), named[0][0])
        elif named:
            attribution = "这 %s 是这么来的：%s，加起来就是风险值。" % (
                _pct(risk, 2), "、".join("%s占 %s" % (n, _pct(v, 2)) for n, v in named))
        else:
            attribution = "设备本身和现场情况都不高，风险值 %s 是两路加起来的结果。" % _pct(risk, 2)

    return {
        "code": device.get("code"), "name": device.get("name"),
        "type": device.get("type"), "location": device.get("location") or "",
        "risk": risk, "raw_risk": raw, "cond_risk": cond,
        "level": level, "headline": headline, "attribution": attribution,
        "split": {"model": round(model_part, 4) if model_part is not None else None,
                  "condition": round(cond_part, 4), "overlap": round(overlap, 4)},
        "signals": signals, "whatif": whatif, "actions": actions,
        "plan": plan,
        "source": device.get("source") or "—",
        "caveats": [c for c in (
            "没有运行数据，设备本身那一路算不出来，现在只按现场情况评级" if device.get("telemetry") is None else
            ("模型不可用，只按现场情况评级" if raw is None and cond is not None else ""),
            "预测异常：%s" % device["error"] if device.get("error") else "",
        ) if c],
    }


# --------------------------------------------------------------------------
# 全局态势
# --------------------------------------------------------------------------
def _group_stats(devices, key):
    """按巷道或型号分组，返回均值与样本数，用于找共性。"""
    buckets = {}
    for d in devices:
        name = (d.get(key) or "未标注").strip() or "未标注"
        buckets.setdefault(name, []).append(d)
    out = []
    for name, group in buckets.items():
        scored = [_num(d.get("risk")) for d in group if _num(d.get("risk")) is not None]
        if not scored:
            continue
        out.append({"name": name, "count": len(group),
                    "mean": round(sum(scored) / len(scored), 4),
                    "max": round(max(scored), 4),
                    "codes": [d.get("code") for d in group]})
    out.sort(key=lambda g: -g["mean"])
    return out


def _factor_effect(factor, devices, hooks):
    """把某个共性工况项在受影响的多台上一起改档，用同一套公式重算平均风险。

    结果写回 factor：changes（改法）、mean_before / mean_after / drop。
    没有闭环重算能力时保持静默，前端会退回定性描述。
    """
    field = ITEM_FIELD.get(factor["name"])
    if not field or not hooks.get("condition_risk"):
        return
    target_fn = WHATIF[field][1]
    unit = FIELD_UNIT.get(field, "")
    before, after, changes, curs = [], [], [], []
    for d in devices:
        if d.get("code") not in factor["codes"]:
            continue
        cal = d.get("calib") or {}
        cur, now = _num(cal.get(field)), _num(d.get("risk"))
        if cur is None or now is None:
            continue
        tgt = target_fn(cur)
        if tgt == cur:
            continue
        try:
            trial = dict(cal)
            trial[field] = tgt
            cond_after, _ = hooks["condition_risk"](trial)
            raw = _num(d.get("raw_risk"))
            risk_after = (hooks["combine"](raw, cond_after)
                          if raw is not None else cond_after)
        except Exception:
            continue
        before.append(now)
        after.append(risk_after)
        curs.append(cur)
        change = ("%s→%s%s" % (_fmt_val(cur), _fmt_val(tgt), unit)).strip()
        if change not in changes:
            changes.append(change)
    if not before:
        return
    # 现场填的值通常是一个档位分布，取最常见的一个说"现在填 X"，
    # 避免和 dashboard 的 per-month 口径混在一起（0.7 次/月 vs 2 次/季）
    factor["now"] = ("%s %s" % (_fmt_val(max(set(curs), key=curs.count)), unit)).strip()
    mb, ma = sum(before) / len(before), sum(after) / len(after)
    factor["changed"] = len(before)
    factor["changes"] = "、".join(changes[:3])
    factor["mean_before"] = round(mb, 4)
    factor["mean_after"] = round(ma, 4)
    factor["drop"] = round(mb - ma, 4)


def analyze_global(state, hooks=None):
    """输入 _state()，输出全局态势 + 共性归因 + 批量方案。"""
    hooks = hooks or {}
    devices = state.get("devices") or []
    counts = state.get("counts") or {}
    total = len(devices)
    scored = [d for d in devices if _num(d.get("risk")) is not None]
    mean = sum(_num(d["risk"]) for d in scored) / len(scored) if scored else 0.0
    worst = scored[0] if scored else None
    no_data = counts.get("gray", 0)
    danger = counts.get("red", 0) + counts.get("orange", 0)

    # 共性：分组均值显著高于全场，且组内 ≥2 台
    patterns = []
    for key, kind in (("location", "同一条巷道"), ("type", "同一型号")):
        for group in _group_stats(devices, key)[:3]:
            if group["count"] >= 2 and mean > 0 and group["mean"] >= max(mean * 1.15, 0.35):
                patterns.append({"kind": kind, "name": group["name"], "count": group["count"],
                                 "mean": group["mean"], "codes": group["codes"],
                                 "note": "%s %d 台平均 %s，比全场 %s 高——多半是%s层面的共性问题" % (
                                     group["name"], group["count"], _pct(group["mean"]), _pct(mean),
                                     "巷道环境" if key == "location" else "设备选型")})

    # 共性工况因素：同一因素在多台机器上都在实质抬高风险。
    # 档位分 0.5 是"中等"（湿度/粉尘 2 级、严酷度 3 档），已经真金白银地扣分，
    # 只筛 >=0.6 会把全场共性因素全部过滤掉，所以改成"档位不低 + 贡献不小"双条件。
    factor_hits = {}
    for d in devices:
        for item in (d.get("cond_items") or []):
            score = float(item.get("score") or 0)
            contrib = float(item.get("contribution") or 0)
            if score >= 0.3 and contrib >= 0.03:
                rec = factor_hits.setdefault(item["name"], {"name": item["name"], "codes": [],
                                                            "weight": item.get("weight"),
                                                            "note": item.get("note")})
                rec["codes"].append(d.get("code"))
    common_factors = sorted(factor_hits.values(), key=lambda f: -len(f["codes"]))
    for f in common_factors:
        f["count"] = len(f["codes"])
        _factor_effect(f, devices, hooks)

    env = state.get("env") or {}
    env_issues = []
    for tunnel, temp in (env.get("env_base_by_tunnel") or {}).items():
        value = _num(temp)
        level = _verdict(value, TH["env_temp_high"], TH["env_temp_mid"])
        if level:
            env_issues.append({"tunnel": tunnel, "temp": value, "level": level,
                               "note": "巷道「%s」基准温度 %.1f℃，配置里这条巷道的设备都按这个温度参考"
                                       % (tunnel, value)})
    default_env = _num(env.get("default_env_base"))
    if default_env is not None and default_env >= TH["env_temp_high"]:
        env_issues.append({"tunnel": "默认基准", "temp": default_env, "level": "高",
                           "note": "没匹配到巷道的设备都用这个温度，先核对填得对不对"})

    # 检修排期分档（窗口口径与单台解读共用 LEVEL_WINDOW）
    buckets = {"这几天": [], "两周内": [], "下次检修": [], "先补数据": []}
    for d in devices:
        window = LEVEL_WINDOW.get((d.get("level") or {}).get("key"))
        if window:
            buckets[window].append(d.get("code"))

    plan = []
    window_reason = WINDOW_REASON
    base = _as_of(state)
    by_code = {d.get("code"): d for d in devices}
    for window, codes in buckets.items():
        if not codes:
            continue
        item = {"window": window, "codes": codes, "count": len(codes),
                "reason": window_reason[window]}
        if window in PLAN_DAYS:
            start, end = base, base + timedelta(days=PLAN_DAYS[window])
            overdue = 0
            if window == "下次检修":
                # 这一档不写死 45 天：按每台自己的到期日取最早/最晚，更能排班
                days = [d for d in (_next_repair_date(by_code.get(c), base) for c in codes) if d]
                if days:
                    start, end = min(days), max(days)
                    overdue = sum(1 for d in days if d < base)
                else:
                    end = start + timedelta(days=PLAN_DAYS[window])
            item["due_from"], item["due_to"] = start.isoformat(), end.isoformat()
            item["overdue"] = overdue
            # 显示区间不倒着写：全部逾期时起点收成"今天"，逾期台数由 overdue 说明
            show_from, show_to = max(start, base), max(end, base)
            item["dates"] = _cn_date(show_to) if show_from == show_to else _date_range(show_from, show_to)
        else:
            item["due_from"] = item["due_to"] = item["dates"] = ""
            item["overdue"] = 0
        plan.append(item)

    actions = []
    if danger:
        actions.append({"priority": "高", "kind": "先处理", "title": "先处理这 %d 台（预警以上）" % danger,
                        "detail": "、".join(d.get("code") for d in scored
                                           if (d.get("level") or {}).get("key") in ("red", "orange"))[:200],
                        "expect": "把最要紧的这几台压回关注级，全场平均风险就下来了"})
    for p in patterns[:3]:
        actions.append({"priority": "高" if p["mean"] >= 0.5 else "中", "kind": "查共性",
                        "title": "%s 一起查：环境和供电" % p["name"],
                        "detail": p["note"],
                        "expect": "一次改好，同组 %d 台都受益，比一台一台整改省力" % p["count"]})
    for f in common_factors[:3]:
        if f.get("drop"):
            expect = ("%d 台一起降一档（%s），平均风险 %s → %s"
                      % (f["changed"], f["changes"], _pct(f["mean_before"]), _pct(f["mean_after"])))
        else:
            expect = "这一项降一档，全场的现场情况分就跟着降"
        actions.append({"priority": "中" if f["count"] >= 3 else "低", "kind": "治现场",
                        "title": "统一治「%s」（%d 台都这样）" % (plain_item(f["name"]), f["count"]),
                        "detail": "现在填 %s，这一项占 %s" % (
                            f.get("now") or f.get("note"), _pct(f.get("weight"), 0)),
                        "expect": expect})
    for e in env_issues[:3]:
        actions.append({"priority": e["level"], "kind": "核对温度",
                        "title": "核对「%s」的基准温度" % e["tunnel"],
                        "detail": e["note"], "expect": "改 sim_config.json 只校正这段分析口径，看板分级仍按实测记录"})
    if no_data:
        actions.append({"priority": "中", "kind": "补数据", "title": "给 %d 台补运行数据" % no_data,
                        "detail": "这些设备现在只按现场情况评级，设备本身那一路是空的",
                        "expect": "接上之后排名和统计才完整"})
    actions.sort(key=lambda a: PRIORITY_ORDER.get(a["priority"], 9))

    if not total:
        headline = "台账里还没有设备，先录入设备。"
    else:
        if danger and worst:
            headline = ("%d 台设备里有 %d 台到了预警或报警，平均风险 %s。"
                        "最要紧的是 %s，风险 %s（%s）。" % (
                            total, danger, _pct(mean), worst.get("name"),
                            _pct(worst.get("risk"), 2),
                            ((worst.get("level") or {}).get("name") or "")))
        elif worst:
            headline = ("共 %d 台，平均风险 %s，没有预警和报警。"
                        "都在「%s」级——不紧急，但下次检修要一起处理，最高的是 %s（%s）。" % (
                            total, _pct(mean), ((worst.get("level") or {}).get("name") or "关注"),
                            worst.get("name"), _pct(worst.get("risk"), 2)))
        else:
            headline = "共 %d 台，暂时算不出风险，先看数据有没有接上。" % total
        if no_data:
            headline += "另有 %d 台没有运行数据。" % no_data

    briefs = [device_brief(d, base) for d in devices]
    return {
        "scope": "global", "headline": headline, "total": total,
        "counts": counts, "mean_risk": round(mean, 4), "danger": danger,
        "no_data": no_data, "model_ready": state.get("model_ready"),
        "top": [device_brief(d, base) for d in scored[:5]],
        "briefs": briefs,
        "patterns": patterns, "common_factors": common_factors,
        "env_issues": env_issues, "plan": plan, "actions": actions,
        "ts": state.get("ts"),
    }


def device_brief(device, base=None):
    """给前端列表、CSV 导出和大模型上下文用的紧凑摘要。"""
    tel = device.get("telemetry") or {}
    return {
        "code": device.get("code"), "name": device.get("name"),
        "type": device.get("type"), "location": device.get("location") or "",
        "risk": _num(device.get("risk")), "raw_risk": _num(device.get("raw_risk")),
        "cond_risk": _num(device.get("cond_risk")),
        "level": (device.get("level") or {}).get("name", "无数据"),
        "plan": _plan_for(device, (device.get("level") or {}).get("key"),
                          base or _as_of(None)),
        "main_cause": _main_cause(device),
        "dev_temp": _num(tel.get("dev_temp")), "env_temp": _num(tel.get("env_temp")),
        "current": _num(tel.get("current")), "rated_i": _num(device.get("rated_i")),
        "since_repair_hours": _num(tel.get("since_repair_hours")),
        "sim_time": tel.get("sim_time"),
    }


def _main_cause(device):
    raw = _num(device.get("raw_risk")) or 0
    cond = _num(device.get("cond_risk")) or 0
    model_part, cond_part, overlap = _split(raw, cond)
    parts = [(PLAIN_DRIVER["model"], model_part), (PLAIN_DRIVER["condition"], cond_part),
             (PLAIN_DRIVER["overlap"], overlap)]
    parts.sort(key=lambda p: -p[1])
    if parts[0][1] <= 0.001:
        return "没有明显抬升"
    return "%s占 %s" % (parts[0][0], _pct(parts[0][1], 2))


# --------------------------------------------------------------------------
# 给 Agent 的上下文（问答时注入 system prompt）
# --------------------------------------------------------------------------
def context_blob(analysis, limit=24):
    """把分析结果压成纯文本，控制在几千字内，避免每次问答都塞满上下文。"""
    if analysis.get("scope") != "global":
        d = analysis
        lines = ["设备：%s（%s，%s，装在 %s）" % (d.get("name"), d.get("code"), d.get("type"),
                                              d.get("location") or "没标巷道"),
                 "结论：%s" % d.get("headline"), "风险怎么来的：%s" % d.get("attribution"),
                 "回答时请照这个口径说人话，不要引用下面的字段名。"]
        for s in (d.get("signals") or [])[:8]:
            lines.append("- 超标：%s %s%s（%s）— %s" % (s["label"], s["value"], s["unit"], s["level"], s["note"]))
        for a in (d.get("actions") or [])[:6]:
            lines.append("- 该做的事[%s]：%s；%s" % (a["priority"], a["title"], a.get("expect") or ""))
        plan = d.get("plan") or {}
        if plan.get("window"):
            lines.append("- 什么时候处理：%s%s%s" % (
                plan["window"],
                "，期限 %s" % plan["dates"] if plan.get("dates") else "",
                "，已到期" if plan.get("overdue") else ""))
        return "\n".join(lines)

    c = analysis["counts"]
    lines = ["全场情况：%s" % analysis.get("headline"),
             "台数：正常 %s 关注 %s 预警 %s 报警 %s，没数据 %s，平均风险 %.1f%%" % (
                 c.get("green", 0), c.get("yellow", 0), c.get("orange", 0), c.get("red", 0),
                 analysis.get("no_data", 0), (analysis.get("mean_risk") or 0) * 100),
             "口径：风险由「设备本身」（温度电流实测）和「现场情况」（潮湿粉尘检修填报）两路合成。"
             "回答时用这两个词，别说模型分、工况分、贡献占比。"]
    for p in (analysis.get("patterns") or [])[:4]:
        lines.append("- 一起出问题的：%s" % p["note"])
    for f in (analysis.get("common_factors") or [])[:4]:
        lines.append("- 多台都有的问题：%s，%d 台，现在填 %s" % (
            plain_item(f["name"]), f["count"], f.get("now") or f.get("note")))
    for e in (analysis.get("env_issues") or [])[:4]:
        lines.append("- 巷道温度：%s" % e["note"])
    for w in (analysis.get("plan") or []):
        span = ("，期限 %s" % w["dates"]) if w.get("dates") else ""
        late = ("，其中 %d 台已到期" % w["overdue"]) if w.get("overdue") else ""
        lines.append("- %s（%d 台%s%s）：%s" % (
            w["window"], w["count"], span, late, "、".join(w["codes"])))
    for b in (analysis.get("briefs") or [])[:limit]:
        lines.append("- %s %s｜风险 %s（%s）｜现场那一路 %s｜主要问题：%s" % (
            b["code"], b["name"], _pct(b["risk"], 2), b["level"],
            _pct(b["cond_risk"], 2), b["main_cause"]))
    return "\n".join(lines)
