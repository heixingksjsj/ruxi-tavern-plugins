/**
 * 世界书诊断器（ruxi-worldbook）—— 入口脚本
 *
 * 功能参考酒馆扩展 DeepLore（pixelnull/sillytavern-DeepLore）的「匹配管线 + Why 诊断」，
 * 针对「入戏」(ai-rp-chat) 重新实现，未复制其源码。
 *
 * 为什么要另做一个而不是直接用宿主的世界书面板：
 *   宿主已有完整的世界书读写与关键词匹配（keys / secondaryKeys / selectiveLogic /
 *   priority / scanDepth / matchWholeWords…），甚至能显示"本轮命中了哪几条"。
 *   但它**只告诉你命中了什么，不告诉你为什么没命中**。条目不生效时用户只能猜：
 *     是关键词写错了？被次要关键词的 NOT 规则排除了？被扫描深度挡在窗口外？
 *     还是优先级太低被 token 预算挤掉了？
 *   这个插件补的就是这一段：**在本地复刻宿主的匹配规则，逐条给出结论与原因**。
 *
 * 说明：诊断是"旁路复算"，不会影响真实生成 —— 即使规则细节与宿主有细微差异，
 * 也只会表现为诊断结论偏差，不会污染实际提示词。
 */
;(function () {
  'use strict'

  var API = window.__ruxiRequire('script.js')

  // ---------------------------------------------------------------- 设置

  var DEFAULTS = {
    /** 诊断时向下扫描的历史消息条数（对应宿主世界书的默认扫描深度） */
    scanDepth: 2,
    /** 是否把"全部条目"都列出来（关掉则只看生效/问题条目） */
    showAll: true,
    /** 新增条目时的默认参数 */
    newEntry: {
      priority: 10,
      constant: false,
      scanDepth: 2,
    },
  }
  var settings = (typeof extension_settings !== 'undefined' && extension_settings) || {}
  Object.keys(DEFAULTS).forEach(function (k) {
    if (settings[k] === undefined) settings[k] = DEFAULTS[k]
  })
  function persist() {
    API.saveSettingsDebounced()
  }

  // ---------------------------------------------------------------- 运行态

  var state = {
    chatId: null,
    roleId: null,
    messages: [],
    entries: [],
    hits: null, // 宿主最近一轮命中（若有）
    lastRun: null, // 本地诊断结果
  }

  // ---------------------------------------------------------------- 匹配规则复刻
  //
  // 与宿主 collectLoreDetailed 的语义对齐：
  //   · 扫描窗口 = 最近 scanDepth 条消息（条目级 scanDepth 可覆盖全局）
  //   · 关键词命中 = 大小写（可配置）/ 全词匹配（可配置）下，扫描文本包含该关键词
  //   · 次要关键词 + selectiveLogic：
  //       0=AND_ANY —— 任一 secondary 命中才通过
  //       1=NOT_ALL —— 不能全部命中
  //       2=NOT_ANY —— 一个都不能命中
  //       3=AND_ALL —— 必须全部命中
  //   · constant=true 的条目跳过关键词判定，始终注入
  //
  // 每条给出 verdict + reason，供 UI 显示"为什么"。

  var SELECTIVE_LOGIC = {
    0: 'AND_ANY',
    1: 'NOT_ALL',
    2: 'NOT_ANY',
    3: 'AND_ALL',
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** 与宿主 normKey 一致：小写 + 去掉所有空白 */
  function normKey(t) {
    return String(t).toLowerCase().replace(/\s+/g, '')
  }

  /**
   * 关键词匹配 —— **严格对齐宿主 engine-parts.ts 的 wiMatch**。
   *
   * ⚠️ 这里踩过坑：第一版复刻写成"小写后直接 indexOf"，看起来对，
   * 实际与宿主有 3 处偏差（已对照源码修正）：
   *   1) 宿主默认路径是 **小写+去空白**（normKey）后匹配，用来兼容社区卡里
   *      关键词的空格变体（"芙宁娜" vs "芙 宁 娜"）；不去空白会漏判。
   *   2) 宿主支持 `/pattern/flags` 形式的正则关键词；不支持的话这类条目会被误判为"未命中"。
   *   3) 全词匹配的边界宿主用的是 `\W`，不是 Unicode 字母类。
   *
   * pool: { raw, rawCase, noSpace } —— 三种池与宿主 WiPools 对应
   */
  function wiMatch(pool, key, entry) {
    var s = String(key == null ? '' : key).trim()
    if (!s) return false

    // 1) /pattern/flags 正则关键词
    var m = s.match(/^\/(.+)\/([a-z]*)$/s)
    if (m) {
      try {
        return new RegExp(m[1], m[2] || 'i').test(pool.rawCase)
      } catch (e) {
        /* 非法正则按普通文本处理，与宿主一致 */
      }
    }

    var wholeWords = !!(entry && entry.matchWholeWords)
    var caseSensitive = !!(entry && entry.caseSensitive)

    // 2) 默认：宽容匹配（小写去空白子串）
    if (!wholeWords && !caseSensitive) return pool.noSpace.indexOf(normKey(s)) >= 0

    var hay = caseSensitive ? pool.rawCase : pool.raw
    var needle = caseSensitive ? s : s.toLowerCase()

    if (wholeWords) {
      var words = needle.split(/\s+/).filter(Boolean)
      if (words.length > 1) return hay.indexOf(needle) >= 0
      try {
        return new RegExp('(?:^|\\W)(' + escapeRe(needle) + ')(?:$|\\W)').test(hay)
      } catch (e) {
        return hay.indexOf(needle) >= 0
      }
    }
    return hay.indexOf(needle) >= 0
  }

  /** 构造三种匹配池（与宿主 WiPools 同构） */
  function buildPool(text) {
    var rawCase = String(text || '')
    return {
      rawCase: rawCase,
      raw: rawCase.toLowerCase(),
      noSpace: normKey(rawCase),
    }
  }

  /** 取扫描文本：最近 depth 条消息拼接 */
  function scanText(messages, depth) {
    if (!messages || messages.length === 0) return ''
    var n = Math.max(1, depth || 1)
    var start = Math.max(0, messages.length - n)
    return messages
      .slice(start)
      .map(function (m) {
        return String((m && m.content) || '')
      })
      .join('\n')
  }

  /** 诊断单条。返回 { verdict, reason, matched, blocked, window } */
  function diagnose(entry, messages, globalDepth) {
    var depth = typeof entry.scanDepth === 'number' && entry.scanDepth > 0 ? entry.scanDepth : globalDepth
    var text = scanText(messages, depth)
    var pool = buildPool(text)

    var keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : []
    var secs = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys.filter(Boolean) : []
    var logic = typeof entry.selectiveLogic === 'number' ? entry.selectiveLogic : 0

    if (!entry.enabled) {
      return { verdict: 'disabled', reason: '条目已停用', matched: [], blocked: [], window: depth }
    }

    if (entry.constant) {
      return {
        verdict: 'active',
        reason: '常驻条目，无需关键词',
        matched: [],
        blocked: [],
        window: depth,
      }
    }

    if (keys.length === 0) {
      return {
        verdict: 'no-key',
        reason: '没有设置任何关键词，也不是常驻条目 —— 永远不会触发',
        matched: [],
        blocked: [],
        window: depth,
      }
    }

    var matched = keys.filter(function (k) {
      return wiMatch(pool, k, entry)
    })

    if (matched.length === 0) {
      var near = nearbyKey(keys, pool, entry)
      return {
        verdict: 'no-match',
        reason: near
          ? '最近的关键词「' + near.k + '」也没命中（扫描了最近 ' + depth + ' 条消息）'
          : '关键词都没出现在最近 ' + depth + ' 条消息里',
        matched: [],
        blocked: [],
        window: depth,
      }
    }

    // 次要关键词判定（四逻辑与宿主 loreActivated 完全对齐）
    var secMatched = secs.filter(function (k) {
      return wiMatch(pool, k, entry)
    })
    var logicName = SELECTIVE_LOGIC[logic] || 'AND_ANY'
    var pass = true
    var blockReason = ''

    if (secs.length > 0) {
      if (logic === 0) {
        pass = secMatched.length > 0
        if (!pass) blockReason = '次要关键词要求「至少命中一个」，但一个都没命中'
      } else if (logic === 1) {
        pass = secMatched.length < secs.length
        if (!pass) blockReason = '次要关键词要求「不能全部命中」，但它们全部出现了'
      } else if (logic === 2) {
        pass = secMatched.length === 0
        if (!pass) blockReason = '次要关键词要求「一个都不能出现」，但命中了：' + secMatched.join('、')
      } else if (logic === 3) {
        pass = secMatched.length === secs.length
        if (!pass) {
          var miss = secs.filter(function (k) {
            return secMatched.indexOf(k) < 0
          })
          blockReason = '次要关键词要求「全部命中」，还差：' + miss.join('、')
        }
      }
    }

    if (!pass) {
      return {
        verdict: 'blocked',
        reason: blockReason + '（逻辑 ' + logicName + '）',
        matched: matched,
        blocked: secMatched,
        window: depth,
      }
    }

    return {
      verdict: 'active',
      reason:
        '命中关键词：' +
        matched.join('、') +
        (secs.length ? '（次要关键词逻辑 ' + logicName + ' 通过）' : ''),
      matched: matched,
      blocked: [],
      window: depth,
    }
  }

  /** 找出与扫描文本"最接近"的关键词：取公共子串最长的那个，便于发现近似拼写 */
  function nearbyKey(keys, pool, entry) {
    var best = null
    var bestScore = 0
    var noSpace = pool.noSpace
    for (var i = 0; i < keys.length; i++) {
      var k = String(keys[i] || '')
      if (!k) continue
      // 正则型关键词不谈"接近"
      if (/^\/.+\/[a-z]*$/s.test(k.trim())) continue
      var kl = normKey(k)
      if (!kl) continue
      var score = 0
      // 逐步变短的子串探测：能匹配到的子串越长，说明越接近
      for (var len = kl.length; len >= 2; len--) {
        if (noSpace.indexOf(kl.slice(0, len)) >= 0) {
          score = len
          break
        }
      }
      if (score > bestScore) {
        bestScore = score
        best = { k: k, score: score }
      }
    }
    // 至少要匹配上 2 个字符才算"接近"
    return best && best.score >= 2 ? best : null
  }

  function runDiagnosis() {
    var globalDepth = Math.max(1, Number(settings.scanDepth) || 2)
    var results = state.entries.map(function (e) {
      var d = diagnose(e, state.messages, globalDepth)
      return {
        entry: e,
        verdict: d.verdict,
        reason: d.reason,
        matched: d.matched,
        blocked: d.blocked,
        window: d.window,
      }
    })
    // 排序：生效的在前，其次是有问题的，最后是停用的
    var order = { active: 0, blocked: 1, 'no-match': 2, 'no-key': 3, disabled: 4 }
    results.sort(function (a, b) {
      var d = (order[a.verdict] || 9) - (order[b.verdict] || 9)
      if (d !== 0) return d
      return (b.entry.priority || 0) - (a.entry.priority || 0)
    })
    state.lastRun = {
      ts: Date.now(),
      results: results,
      depth: globalDepth,
      msgCount: state.messages.length,
    }
    return state.lastRun
  }

  // ---------------------------------------------------------------- 数据同步

  async function refresh() {
    var ctx = await API.getContext()
    if (ctx) {
      state.chatId = ctx.chatId
      state.messages = Array.isArray(ctx.chat) ? ctx.chat : []
    }
    try {
      var wi = await API.getWorldInfo()
      state.roleId = wi && wi.roleId
      state.entries = (wi && Array.isArray(wi.entries) ? wi.entries : []).slice()
    } catch (e) {
      state.entries = []
    }
    try {
      state.hits = await API.getLastLoreHits()
    } catch (e) {
      state.hits = null
    }
  }

  // ---------------------------------------------------------------- UI

  var root = null
  var listEl = null
  var statusEl = null

  function css() {
    return (
      '.rw-wrap{font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;color:#2b2b2b;padding:12px;max-width:860px;margin:0 auto}' +
      '.rw-card{background:#fff;border:1px solid #e8e2da;border-radius:12px;padding:14px;margin-bottom:12px}' +
      '.rw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}' +
      '.rw-row:last-child{margin-bottom:0}' +
      '.rw-label{font-size:13px;color:#6b6b6b}' +
      '.rw-btn{appearance:none;border:1px solid #e0d8ce;background:#fff;color:#2b2b2b;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;transition:.15s}' +
      '.rw-btn:hover{background:#faf7f3}.rw-btn:active{transform:scale(.98)}' +
      '.rw-btn:disabled{opacity:.45;cursor:not-allowed}' +
      '.rw-btn.primary{background:#e8654a;border-color:#e8654a;color:#fff;font-weight:600}' +
      '.rw-btn.primary:hover{background:#d4553c}' +
      '.rw-btn.mini{padding:3px 9px;font-size:12px;border-radius:6px}' +
      '.rw-btn.danger{color:#c0392b;border-color:#f0d5d0}' +
      '.rw-inp{border:1px solid #e0d8ce;border-radius:8px;padding:6px 10px;font-size:13px;font-family:inherit;background:#fff;color:#2b2b2b}' +
      '.rw-num{width:74px}' +
      '.rw-ta{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;border:1px solid #e0d8ce;border-radius:8px;padding:8px 10px;font:13px/1.6 inherit;background:#fff;color:#2b2b2b}' +
      '.rw-item{border:1px solid #eee7df;border-radius:9px;padding:10px 12px;margin-bottom:8px;background:#fdfcfa}' +
      '.rw-item-h{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:5px;flex-wrap:wrap}' +
      '.rw-name{font-weight:600;font-size:13.5px;word-break:break-word}' +
      '.rw-badge{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;font-weight:600}' +
      '.rw-b-active{background:#e7f6ec;color:#1f7a45}' +
      '.rw-b-blocked{background:#fdf0e3;color:#b3641b}' +
      '.rw-b-nomatch{background:#f2f0ec;color:#7a7268}' +
      '.rw-b-nokey{background:#fdeaea;color:#c0392b}' +
      '.rw-b-disabled{background:#f4f2ef;color:#9a9188}' +
      '.rw-why{font-size:12.5px;color:#6b6b6b;line-height:1.6;margin-top:3px;word-break:break-word}' +
      '.rw-keys{margin-top:5px;display:flex;gap:4px;flex-wrap:wrap}' +
      '.rw-key{font-size:11px;background:#f3efe9;color:#6b6b6b;border-radius:4px;padding:1px 6px}' +
      '.rw-key.hit{background:#e7f6ec;color:#1f7a45;font-weight:600}' +
      '.rw-key.blk{background:#fdeaea;color:#c0392b}' +
      '.rw-empty{color:#9a9188;font-size:13px;text-align:center;padding:22px 0}' +
      '.rw-status{font-size:12px;color:#8a8178;min-height:18px;margin-bottom:6px}' +
      '.rw-tip{font-size:12px;color:#9a9188;line-height:1.65;margin-top:8px}' +
      '.rw-sum{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:#6b6b6b}' +
      '.rw-sum b{color:#2b2b2b}' +
      '.rw-edit{margin-top:8px;border-top:1px dashed #e8e2da;padding-top:8px}'
    )
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return
    var st = document.createElement('style')
    st.textContent = css()
    document.head.appendChild(st)

    root = document.createElement('div')
    root.className = 'rw-wrap'
    root.innerHTML = [
      '<div class="rw-card">',
      '  <div class="rw-row">',
      '    <button class="rw-btn primary" id="rw-run">重新诊断</button>',
      '    <span class="rw-label">扫描最近</span>',
      '    <input class="rw-inp rw-num" id="rw-depth" type="number" min="1" max="50">',
      '    <span class="rw-label">条消息</span>',
      '    <label class="rw-label" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer">',
      '      <input type="checkbox" id="rw-all" style="accent-color:#e8654a"> 显示全部条目',
      '    </label>',
      '  </div>',
      '  <div class="rw-status" id="rw-status"></div>',
      '  <div class="rw-sum" id="rw-sum"></div>',
      '</div>',
      '<div class="rw-card">',
      '  <div class="rw-label" style="margin-bottom:8px">条目诊断（为什么生效 / 为什么不生效）</div>',
      '  <div id="rw-list"></div>',
      '  <div class="rw-tip">诊断在本地复算宿主的匹配规则，只是旁路分析，不会改动你的世界书，也不影响实际生成。</div>',
      '</div>',
    ].join('\n')
    document.body.appendChild(root)

    listEl = root.querySelector('#rw-list')
    statusEl = root.querySelector('#rw-status')

    root.querySelector('#rw-run').addEventListener('click', function () {
      void doDiagnose()
    })
    root.querySelector('#rw-depth').addEventListener('change', function (e) {
      settings.scanDepth = Math.max(1, parseInt(e.target.value, 10) || 2)
      persist()
      void doDiagnose()
    })
    root.querySelector('#rw-all').addEventListener('change', function (e) {
      settings.showAll = e.target.checked
      persist()
      renderList()
    })

    syncForm()
  }

  function syncForm() {
    if (!root) return
    root.querySelector('#rw-depth').value = settings.scanDepth
    root.querySelector('#rw-all').checked = !!settings.showAll
  }

  function renderStatus(t) {
    if (statusEl) statusEl.textContent = t || ''
  }

  function renderSummary() {
    var el = root && root.querySelector('#rw-sum')
    if (!el) return
    var run = state.lastRun
    if (!run) {
      el.innerHTML = ''
      return
    }
    var n = { active: 0, blocked: 0, 'no-match': 0, 'no-key': 0, disabled: 0 }
    run.results.forEach(function (r) {
      n[r.verdict] = (n[r.verdict] || 0) + 1
    })
    var hostHits = state.hits && state.hits.ran ? state.hits.hits.length : null
    el.innerHTML =
      '<span>条目 <b>' +
      run.results.length +
      '</b></span>' +
      '<span style="color:#1f7a45">生效 <b>' +
      n.active +
      '</b></span>' +
      (n.blocked ? '<span style="color:#b3641b">被规则挡下 <b>' + n.blocked + '</b></span>' : '') +
      (n['no-match'] ? '<span>未命中 <b>' + n['no-match'] + '</b></span>' : '') +
      (n['no-key'] ? '<span style="color:#c0392b">未设关键词 <b>' + n['no-key'] + '</b></span>' : '') +
      '<span>扫描 <b>' +
      run.depth +
      '</b> 条 / 共 <b>' +
      run.msgCount +
      '</b> 条消息</span>' +
      (hostHits !== null ? '<span>宿主上轮命中 <b>' + hostHits + '</b></span>' : '')
  }

  var VERDICT_META = {
    active: { label: '生效', cls: 'rw-b-active' },
    blocked: { label: '被规则挡下', cls: 'rw-b-blocked' },
    'no-match': { label: '未命中', cls: 'rw-b-nomatch' },
    'no-key': { label: '未设关键词', cls: 'rw-b-nokey' },
    disabled: { label: '已停用', cls: 'rw-b-disabled' },
  }

  function renderList() {
    if (!listEl) return
    var run = state.lastRun
    if (!run) {
      listEl.innerHTML = '<div class="rw-empty">点上面的「重新诊断」开始。</div>'
      return
    }
    // 诊断期间被编辑过诊断结果也一并更新，保持与最新数据一致
    var results = run.results
    if (!settings.showAll) {
      results = results.filter(function (r) {
        return r.verdict !== 'disabled'
      })
    }
    if (results.length === 0) {
      listEl.innerHTML = '<div class="rw-empty">没有条目。请先在世界书面板里添加。</div>'
      return
    }
    listEl.innerHTML = results
      .map(function (r) {
        var e = r.entry
        var meta = VERDICT_META[r.verdict] || VERDICT_META['no-match']
        var keysHtml = (Array.isArray(e.keys) ? e.keys : [])
          .map(function (k) {
            var hit = r.matched.indexOf(k) >= 0
            return '<span class="rw-key' + (hit ? ' hit' : '') + '">' + esc(k) + '</span>'
          })
          .join('')
        var secHtml = (Array.isArray(e.secondaryKeys) ? e.secondaryKeys : [])
          .map(function (k) {
            var blk = r.blocked.indexOf(k) >= 0
            return '<span class="rw-key' + (blk ? ' blk' : '') + '">' + esc(k) + '</span>'
          })
          .join('')
        var name = e.comment || (Array.isArray(e.keys) && e.keys.length ? e.keys.join('、') : '（未命名条目）')
        return (
          '<div class="rw-item">' +
          '<div class="rw-item-h">' +
          '<div><div class="rw-name">' +
          esc(name) +
          (e.constant ? ' <span class="rw-key">常驻</span>' : '') +
          '</div></div>' +
          '<span class="rw-badge ' +
          meta.cls +
          '">' +
          meta.label +
          '</span>' +
          '</div>' +
          '<div class="rw-why">' +
          esc(r.reason) +
          '</div>' +
          (keysHtml ? '<div class="rw-keys">' + keysHtml + '</div>' : '') +
          (secHtml ? '<div class="rw-keys">次要：' + secHtml + '</div>' : '') +
          '<div class="rw-idx" style="font-size:12px;color:#9a9188;margin-top:4px">优先级 ' +
          (e.priority || 0) +
          ' · 扫描 ' +
          r.window +
          ' 条' +
          (typeof e.position === 'number' ? ' · 位置 ' + e.position : '') +
          '</div>' +
          '<div class="rw-edit">' +
          '<button class="rw-btn mini" data-act="toggle" data-id="' +
          esc(e.id) +
          '">' +
          (e.enabled ? '停用' : '启用') +
          '</button> ' +
          '<button class="rw-btn mini" data-act="test" data-id="' +
          esc(e.id) +
          '">试算关键词</button>' +
          '</div>' +
          '</div>'
        )
      })
      .join('')

    listEl.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id')
        var act = btn.getAttribute('data-act')
        var entry = state.entries.filter(function (x) {
          return x.id === id
        })[0]
        if (!entry) return
        if (act === 'toggle') {
          void (async function () {
            entry.enabled = !entry.enabled
            await API.saveWorldInfoEntry(entry)
            await refresh()
            doDiagnose()
          })()
        } else if (act === 'test') {
          var words = prompt('输入要试算的文本片段（会用这条的关键词规则去匹配）：', '')
          if (words === null) return
          var p = buildPool(words)
          var hit = (Array.isArray(entry.keys) ? entry.keys : []).filter(function (k) {
            return wiMatch(p, k, entry)
          })
          alert(
            hit.length
              ? '✅ 命中 ' + hit.length + ' 个关键词：' + hit.join('、')
              : '❌ 没有命中任何关键词' +
                  (entry.matchWholeWords ? '（本条开启了全词匹配，注意单词边界）' : ''),
          )
        }
      })
    })
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function doDiagnose() {
    ensureRoot()
    if (!state.roleId) {
      state.lastRun = { ts: Date.now(), results: [], depth: settings.scanDepth, msgCount: 0 }
      renderSummary()
      listEl.innerHTML = '<div class="rw-empty">当前会话没有关联角色，读不到世界书条目。</div>'
      renderStatus('未选择角色')
      return
    }
    runDiagnosis()
    renderSummary()
    renderList()
    renderStatus('诊断完成 · ' + new Date(state.lastRun.ts).toLocaleTimeString())
    setTimeout(function () {
      renderStatus('')
    }, 2600)
  }

  // ---------------------------------------------------------------- 启动

  async function boot() {
    ensureRoot()
    await refresh()
    doDiagnose()
  }

  function hook() {
    var ET = API.event_types || {}
    var pend = null
    function schedule() {
      if (pend) clearTimeout(pend)
      pend = setTimeout(function () {
        pend = null
        void refresh().then(function () {
          if (state.lastRun) doDiagnose()
        })
      }, 500)
    }
    ;['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_DELETED', 'GENERATION_ENDED'].forEach(
      function (name) {
        var ev = ET[name]
        if (ev && API.eventSource && typeof API.eventSource.on === 'function') {
          API.eventSource.on(ev, schedule)
        }
      },
    )
    // 世界书在别的面板被改动时，本面板没有事件可听 —— 用轮询兜住
    var lastSig = ''
    setInterval(function () {
      var sig = state.roleId + ':' + state.entries.length + ':' + state.messages.length
      if (sig !== lastSig) {
        lastSig = sig
        void refresh().then(function () {
          if (state.lastRun) doDiagnose()
        })
      }
    }, 5000)
  }

  ;(async function () {
    try {
      await boot()
      hook()
    } catch (e) {
      console.error('[ruxi-worldbook] 启动失败', e)
      try {
        ensureRoot()
        renderStatus('启动失败：' + ((e && e.message) || e))
      } catch (_) {
        /* 放弃 */
      }
    }
  })()
})()
