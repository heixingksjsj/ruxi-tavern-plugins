/**
 * 消息摘要（ruxi-summarize）—— 入口脚本
 *
 * 功能参考酒馆扩展 MessageSummarize（qvink/SillyTavern-MessageSummarize），
 * 针对「入戏」(ai-rp-chat) 的扩展运行时**重新实现**，未复制其源码。
 *
 * 核心思路：
 *   1. 给每条消息生成一段简短摘要，存在扩展自己的设置里（按会话隔离）
 *   2. 把「近期摘要」与「更早摘要」分成 short / long 两组，拼成一段文本
 *   3. 通过宿主新增的上下文注入接口，把这段文本送进模型提示词
 *      → 长对话即使裁掉了原始消息，剧情也不会断片
 *
 * 与酒馆版的主要差异：
 *   - 酒馆把摘要写进 message.extra；本宿主不便扩展消息对象，改为独立存储（按会话 id 分桶）
 *   - 酒馆按 token 阈值触发；宿主无 tokenizer，改为按**估算 token**（字符数/2，中文近似）
 *   - 砍掉了 profile 系统、swipe 分支摘要、正则后处理（保留单一全局配置）
 *
 * 运行环境：sandbox iframe（buildRuntimeHostDoc 注入），
 * 宿主 API 通过 window.__ruxiRequire('script.js') 获取。
 */
;(function () {
  'use strict'

  var API = window.__ruxiRequire('script.js')
  var utils = window.__ruxiRequire('utils')

  // ---------------------------------------------------------------- 设置

  var DEFAULTS = {
    enabled: true,
    /** 生成摘要用的提示词模板（{{content}} 会被替换成消息原文） */
    promptTemplate:
      '请用一两句话（不超过 {maxLen} 字）概括下面这段角色扮演对话的内容，' +
      '只保留对后续剧情有影响的信息：人物关系变化、做出的承诺、发生的关键事件、' +
      '获得的物品或线索。不要评价，不要加标题，直接输出概括本身。\n\n---\n{content}',
    /** 单条摘要长度上限（字符） */
    maxLen: 120,
    /** 自动总结开关 */
    autoSummarize: true,
    /** 每累计多少条未总结消息后触发一次自动总结 */
    autoThreshold: 4,
    /** 注入位置：in_prompt=系统提示尾部；in_chat=插入对话历史 */
    position: 'in_prompt',
    /** position=in_chat 时的深度 */
    depth: 2,
    /** 保留为「近期摘要」的条数，其余归入「更早摘要」 */
    shortCount: 6,
    /** 更早摘要最多注入多少条（防止无限膨胀） */
    longMax: 20,
    /** 注入模板 */
    injectTemplate:
      '【此前剧情摘要】\n{short}\n\n【更早的剧情梗概】\n{long}',
  }
  var settings = (typeof extension_settings !== 'undefined' && extension_settings) || {}
  Object.keys(DEFAULTS).forEach(function (k) {
    if (settings[k] === undefined) settings[k] = DEFAULTS[k]
  })
  function persist() {
    API.saveSettingsDebounced()
  }

  // ---------------------------------------------------------------- 存储
  // 摘要按「会话 id」分桶存在扩展设置里。键：summaries[chatId][messageIndex]
  // 说明：宿主消息对象没有稳定 id，用「消息下标 + 内容指纹」定位，
  // 内容变了指纹就变，摘要会被判定过期（与酒馆的 hash 校验同思路）。

  function ensureStore() {
    if (!settings.summaries || typeof settings.summaries !== 'object') settings.summaries = {}
    return settings.summaries
  }
  function bucket(chatId) {
    var s = ensureStore()
    if (!s[chatId]) s[chatId] = {}
    return s[chatId]
  }
  function fingerprint(text) {
    // 轻量指纹：长度 + 首尾片段 + 简单滚动哈希（无需加密强度）
    var t = String(text || '')
    var h = 0
    for (var i = 0; i < t.length; i++) {
      h = (h * 31 + t.charCodeAt(i)) | 0
    }
    return t.length + ':' + (h >>> 0).toString(36) + ':' + t.slice(0, 12)
  }

  function getSummary(chatId, idx, text) {
    var b = bucket(chatId)
    var rec = b[idx]
    if (!rec) return null
    if (text !== undefined && rec.fp !== fingerprint(text)) return null // 已过期
    return rec
  }
  function putSummary(chatId, idx, text, summary, kind) {
    var b = bucket(chatId)
    b[idx] = {
      text: String(summary || ''),
      fp: fingerprint(text),
      kind: kind || 'short',
      edited: false,
      error: null,
      createdAt: Date.now(),
    }
    trimStore(chatId)
    persist()
  }

  /** 防膨胀：单个会话的摘要条数设上限，超出时丢弃最早的。
   *  设置对象会被整体 JSON 序列化进 IndexedDB，无上限时长会话会拖慢每次读写。 */
  var MAX_PER_CHAT = 500
  function trimStore(chatId) {
    var b = bucket(chatId)
    var keys = Object.keys(b)
    if (keys.length <= MAX_PER_CHAT) return
    keys
      .map(function (k) {
        return parseInt(k, 10)
      })
      .sort(function (a, c) {
        return a - c
      })
      .slice(0, keys.length - MAX_PER_CHAT)
      .forEach(function (k) {
        delete b[k]
      })
  }

  /** 防膨胀：限制保存摘要的会话数量（用户可能聊过上百个会话）。
   *  只保留最近有摘要活动的若干个会话。 */
  var MAX_CHATS = 40
  function trimChats() {
    var s = ensureStore()
    var ids = Object.keys(s)
    if (ids.length <= MAX_CHATS) return
    ids
      .map(function (id) {
        var b = s[id] || {}
        var latest = 0
        Object.keys(b).forEach(function (k) {
          var t = b[k] && b[k].createdAt ? b[k].createdAt : 0
          if (t > latest) latest = t
        })
        return { id: id, t: latest }
      })
      .sort(function (a, c) {
        return a.t - c.t
      })
      .slice(0, ids.length - MAX_CHATS)
      .forEach(function (x) {
        delete s[x.id]
      })
  }
  function delSummary(chatId, idx) {
    var b = bucket(chatId)
    delete b[idx]
    persist()
  }

  // ---------------------------------------------------------------- 运行态

  var state = {
    chatId: null,
    messages: [],
    busy: false,
    autoRunning: false,
    /** idx → 摘要记录（当前会话） */
    cache: {},
  }

  function tokenEstimate(text) {
    // 无 tokenizer 时的近似：ASCII 字符约 4 字符/token，CJK 约 1 字符/token。
    // 取折中值 —— 中文为主的 RP 场景下 character/2 误差最小。
    var t = String(text || '')
    if (!t) return 0
    var ascii = (t.match(/[\x00-\x7F]/g) || []).length
    var cjk = t.length - ascii
    return Math.ceil(ascii / 4 + cjk)
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ---------------------------------------------------------------- 摘要生成

  function buildPrompt(content) {
    var maxLen = Number(settings.maxLen) || 120
    return String(settings.promptTemplate)
      .replace(/\{maxLen\}/g, String(maxLen))
      .replace(/\{content\}/g, String(content || '').slice(0, 8000))
  }

  /** 清洗模型输出：去掉常见的前后缀噪声，截到长度上限 */
  function cleanSummary(raw) {
    var t = String(raw || '').trim()
    t = t.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')
    t = t.replace(/^(摘要|概括|总结)[：:]\s*/, '')
    t = t.replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    t = t.trim()
    var maxLen = Number(settings.maxLen) || 120
    if (t.length > maxLen) t = t.slice(0, maxLen).replace(/[，,。.、；;]$/, '') + '…'
    return t
  }

  async function summarizeOne(idx) {
    var m = state.messages[idx]
    if (!m) return { ok: false, error: '消息不存在' }
    var text = String(m.content || '')
    if (!text.trim()) return { ok: false, error: '这条消息是空的' }
    var out = await API.generateQuietPrompt(buildPrompt(text))
    var s = cleanSummary(typeof out === 'string' ? out : (out && out.content) || '')
    if (!s) return { ok: false, error: '模型返回了空摘要' }
    putSummary(state.chatId, idx, text, s)
    state.cache = bucket(state.chatId)
    return { ok: true, summary: s }
  }

  /** 自动总结：找出未总结的旧消息（跳过最近 autoThreshold 条，它们还在上下文里）
   *  @param force 手动触发时传 true —— 忽略「自动总结」开关，否则用户关掉自动后
   *               点「总结未处理的消息」会毫无反应（看起来像坏了） */
  async function runAuto(force) {
    if (state.autoRunning || !state.chatId) return
    if (!force && !settings.autoSummarize) return
    var total = state.messages.length
    var threshold = force ? 0 : Math.max(1, Number(settings.autoThreshold) || 4)
    var end = total - threshold // 最近 threshold 条不总结（手动触发则全量检查）
    if (end <= 0) return

    var pending = []
    for (var i = 0; i < end; i++) {
      var m = state.messages[i]
      if (!m || !String(m.content || '').trim()) continue
      if (!getSummary(state.chatId, i, m.content)) pending.push(i)
    }
    if (pending.length === 0) {
      if (force) {
        renderStatus('没有需要处理的消息')
        setTimeout(function () {
          renderStatus('')
        }, 2200)
      }
      return
    }

    state.autoRunning = true
    renderStatus('自动总结中… 0/' + pending.length)
    var done = 0
    try {
      // 逐条串行：并发会让廉价模型更容易返回错乱内容，且不好定位失败项
      for (var k = 0; k < pending.length; k++) {
        try {
          await summarizeOne(pending[k])
        } catch (e) {
          var b = bucket(state.chatId)
          b[pending[k]] = {
            text: '',
            fp: fingerprint(state.messages[pending[k]].content),
            kind: 'short',
            edited: false,
            error: String((e && e.message) || e),
            createdAt: Date.now(),
          }
        }
        done++
        renderStatus('自动总结中… ' + done + '/' + pending.length)
      }
      persist()
      renderStatus('自动总结完成（' + done + ' 条）')
      renderList()
      pushInjection()
    } finally {
      state.autoRunning = false
      setTimeout(function () {
        renderStatus('')
      }, 2600)
    }
  }

  // ---------------------------------------------------------------- 注入

  /** 把摘要拼成一段文本，推给宿主（每次摘要变化后调用） */
  function pushInjection() {
    if (!state.chatId) return
    if (!settings.enabled) {
      API.setContextInjection('summarize', '')
      return
    }
    var b = bucket(state.chatId)
    var items = []
    Object.keys(b).forEach(function (k) {
      var idx = parseInt(k, 10)
      var rec = b[idx]
      if (!rec || !rec.text) return
      items.push({ idx: idx, text: rec.text })
    })
    items.sort(function (a, c) {
      return a.idx - c.idx
    })
    if (items.length === 0) {
      API.setContextInjection('summarize', '')
      return
    }
    var shortCount = Math.max(1, Number(settings.shortCount) || 6)
    var longMax = Math.max(0, Number(settings.longMax) || 20)
    var longPart = items.slice(0, Math.max(0, items.length - shortCount))
    var shortPart = items.slice(Math.max(0, items.length - shortCount))
    if (longPart.length > longMax) longPart = longPart.slice(longPart.length - longMax)

    var fmt = function (arr) {
      return arr
        .map(function (x) {
          return '- ' + x.text
        })
        .join('\n')
    }
    var text = String(settings.injectTemplate)
      .replace('{short}', fmt(shortPart))
      .replace('{long}', longPart.length ? fmt(longPart) : '（暂无）')

    API.setContextInjection('summarize', text)
  }

  async function registerInjection() {
    await API.registerContextInjection({
      id: 'summarize',
      position: settings.position === 'in_chat' ? 'in_chat' : 'in_prompt',
      depth: Number(settings.depth) || 2,
      role: 'system',
    })
    pushInjection()
  }

  // ---------------------------------------------------------------- UI

  var root = null
  var listEl = null
  var statusEl = null

  function css() {
    return (
      '.rs-wrap{font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;color:#2b2b2b;padding:12px;max-width:760px;margin:0 auto}' +
      '.rs-card{background:#fff;border:1px solid #e8e2da;border-radius:12px;padding:14px;margin-bottom:12px}' +
      '.rs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}' +
      '.rs-row:last-child{margin-bottom:0}' +
      '.rs-label{font-size:13px;color:#6b6b6b;min-width:76px}' +
      '.rs-btn{appearance:none;border:1px solid #e0d8ce;background:#fff;color:#2b2b2b;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;transition:.15s}' +
      '.rs-btn:hover{background:#faf7f3}' +
      '.rs-btn:active{transform:scale(.98)}' +
      '.rs-btn:disabled{opacity:.45;cursor:not-allowed}' +
      '.rs-btn.primary{background:#e8654a;border-color:#e8654a;color:#fff;font-weight:600}' +
      '.rs-btn.primary:hover{background:#d4553c}' +
      '.rs-btn.mini{padding:3px 9px;font-size:12px;border-radius:6px}' +
      '.rs-btn.danger{color:#c0392b;border-color:#f0d5d0}' +
      '.rs-inp{border:1px solid #e0d8ce;border-radius:8px;padding:6px 10px;font-size:13px;font-family:inherit;background:#fff;color:#2b2b2b}' +
      '.rs-num{width:74px}' +
      '.rs-ta{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;border:1px solid #e0d8ce;border-radius:8px;padding:8px 10px;font:13px/1.6 inherit;background:#fff;color:#2b2b2b}' +
      '.rs-list{margin-top:6px}' +
      '.rs-item{border:1px solid #eee7df;border-radius:9px;padding:9px 11px;margin-bottom:8px;background:#fdfcfa}' +
      '.rs-item-h{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:5px}' +
      '.rs-idx{font-size:12px;color:#9a9188}' +
      '.rs-sum{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}' +
      '.rs-empty{color:#9a9188;font-size:13px;text-align:center;padding:22px 0}' +
      '.rs-err{color:#c0392b;font-size:12px}' +
      '.rs-status{font-size:12px;color:#8a8178;min-height:18px;margin-bottom:6px}' +
      '.rs-tip{font-size:12px;color:#9a9188;line-height:1.65;margin-top:6px}' +
      '.rs-sw{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;user-select:none}' +
      '.rs-sw input{width:15px;height:15px;accent-color:#e8654a}'
    )
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return
    var st = document.createElement('style')
    st.textContent = css()
    document.head.appendChild(st)

    root = document.createElement('div')
    root.className = 'rs-wrap'
    root.innerHTML = [
      '<div class="rs-card">',
      '  <div class="rs-row">',
      '    <label class="rs-sw"><input type="checkbox" id="rs-enabled"> 启用摘要注入</label>',
      '    <label class="rs-sw"><input type="checkbox" id="rs-auto"> 自动总结</label>',
      '    <span class="rs-label">每</span>',
      '    <input class="rs-inp rs-num" id="rs-thr" type="number" min="1" max="50">',
      '    <span class="rs-label" style="min-width:0">条触发</span>',
      '  </div>',
      '  <div class="rs-status" id="rs-status"></div>',
      '  <div class="rs-row">',
      '    <button class="rs-btn primary" id="rs-run">总结未处理的消息</button>',
      '    <button class="rs-btn" id="rs-all">重新总结全部</button>',
      '    <button class="rs-btn" id="rs-clear">清空本会话摘要</button>',
      '  </div>',
      '</div>',
      '<div class="rs-card">',
      '  <div class="rs-row">',
      '    <span class="rs-label">注入位置</span>',
      '    <select class="rs-inp" id="rs-pos">',
      '      <option value="in_prompt">系统提示末尾（推荐）</option>',
      '      <option value="in_chat">插入对话历史</option>',
      '    </select>',
      '    <span class="rs-label">深度</span>',
      '    <input class="rs-inp rs-num" id="rs-depth" type="number" min="0" max="30">',
      '    <span class="rs-label">近期保留</span>',
      '    <input class="rs-inp rs-num" id="rs-short" type="number" min="1" max="30">',
      '  </div>',
      '  <div class="rs-row" style="display:block">',
      '    <div class="rs-label" style="margin-bottom:4px">摘要提示词（{content} 为消息原文，{maxLen} 为字数上限）</div>',
      '    <textarea class="rs-ta" id="rs-tpl"></textarea>',
      '    <div class="rs-label" style="margin:6px 0 4px">注入模板（{short}=近期摘要，{long}=更早摘要）</div>',
      '    <textarea class="rs-ta" id="rs-injtpl" style="min-height:58px"></textarea>',
      '  </div>',
      '  <div class="rs-row">',
      '    <button class="rs-btn" id="rs-save">保存设置</button>',
      '    <span class="rs-tip" style="margin:0">保存后立即生效</span>',
      '  </div>',
      '</div>',
      '<div class="rs-card">',
      '  <div class="rs-label" style="margin-bottom:6px">本会话摘要列表</div>',
      '  <div class="rs-list" id="rs-list"></div>',
      '  <div class="rs-tip">摘要按会话单独保存；消息被编辑后其摘要会自动标记为过期并重新生成。</div>',
      '</div>',
    ].join('\n')
    document.body.appendChild(root)

    listEl = root.querySelector('#rs-list')
    statusEl = root.querySelector('#rs-status')

    root.querySelector('#rs-enabled').addEventListener('change', function (e) {
      settings.enabled = e.target.checked
      persist()
      pushInjection()
    })
    root.querySelector('#rs-auto').addEventListener('change', function (e) {
      settings.autoSummarize = e.target.checked
      persist()
    })
    root.querySelector('#rs-thr').addEventListener('change', function (e) {
      settings.autoThreshold = Math.max(1, parseInt(e.target.value, 10) || 4)
      persist()
    })
    root.querySelector('#rs-run').addEventListener('click', function () {
      void runAuto(true)
    })
    root.querySelector('#rs-all').addEventListener('click', function () {
      void resummarizeAll()
    })
    root.querySelector('#rs-clear').addEventListener('click', function () {
      if (!confirm('确定清空本会话的全部摘要？此操作不可撤销。')) return
      settings.summaries[state.chatId] = {}
      persist()
      state.cache = {}
      pushInjection()
      renderList()
    })
    root.querySelector('#rs-save').addEventListener('click', function () {
      settings.promptTemplate = root.querySelector('#rs-tpl').value
      settings.injectTemplate = root.querySelector('#rs-injtpl').value
      settings.position = root.querySelector('#rs-pos').value
      settings.depth = parseInt(root.querySelector('#rs-depth').value, 10) || 0
      settings.shortCount = Math.max(1, parseInt(root.querySelector('#rs-short').value, 10) || 6)
      persist()
      void registerInjection()
      renderStatus('设置已保存')
      setTimeout(function () {
        renderStatus('')
      }, 1800)
    })

    syncForm()
  }

  function syncForm() {
    if (!root) return
    root.querySelector('#rs-enabled').checked = !!settings.enabled
    root.querySelector('#rs-auto').checked = !!settings.autoSummarize
    root.querySelector('#rs-thr').value = settings.autoThreshold
    root.querySelector('#rs-pos').value = settings.position
    root.querySelector('#rs-depth').value = settings.depth
    root.querySelector('#rs-short').value = settings.shortCount
    root.querySelector('#rs-tpl').value = settings.promptTemplate
    root.querySelector('#rs-injtpl').value = settings.injectTemplate
  }

  function renderStatus(t) {
    if (!statusEl) return
    statusEl.textContent = t || ''
  }

  function renderList() {
    if (!listEl) return
    var b = state.chatId ? bucket(state.chatId) : {}
    var keys = Object.keys(b).sort(function (a, c) {
      return parseInt(a, 10) - parseInt(c, 10)
    })
    if (keys.length === 0) {
      listEl.innerHTML = '<div class="rs-empty">还没有摘要。点上面的「总结未处理的消息」开始。</div>'
      return
    }
    listEl.innerHTML = keys
      .map(function (k) {
        var rec = b[k]
        var idx = parseInt(k, 10)
        var m = state.messages[idx]
        var stale = m && rec.fp !== fingerprint(m.content)
        var preview = m ? String(m.content).slice(0, 60).replace(/\s+/g, ' ') : '（消息已不在当前会话）'
        var body = rec.error
          ? '<div class="rs-err">生成失败：' + escapeHtml(rec.error) + '</div>'
          : '<div class="rs-sum">' + escapeHtml(rec.text) + '</div>'
        return (
          '<div class="rs-item" data-idx="' +
          idx +
          '">' +
          '<div class="rs-item-h">' +
          '<span class="rs-idx">#' +
          (idx + 1) +
          (stale ? ' · <span style="color:#e08a3c">已过期</span>' : '') +
          '</span>' +
          '<span>' +
          '<button class="rs-btn mini" data-act="edit">编辑</button> ' +
          '<button class="rs-btn mini" data-act="regen">重生成</button> ' +
          '<button class="rs-btn mini danger" data-act="del">删除</button>' +
          '</span>' +
          '</div>' +
          '<div class="rs-idx" style="margin-bottom:4px">原文：' +
          escapeHtml(preview) +
          '…</div>' +
          body +
          '</div>'
        )
      })
      .join('')

    listEl.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = btn.closest('.rs-item')
        var idx = parseInt(item.getAttribute('data-idx'), 10)
        var act = btn.getAttribute('data-act')
        if (act === 'del') {
          delSummary(state.chatId, idx)
          state.cache = bucket(state.chatId)
          pushInjection()
          renderList()
        } else if (act === 'regen') {
          void (async function () {
            renderStatus('重新生成中…')
            try {
              await summarizeOne(idx)
              renderStatus('已重新生成')
            } catch (e) {
              renderStatus('失败：' + ((e && e.message) || e))
            }
            renderList()
            pushInjection()
            setTimeout(function () {
              renderStatus('')
            }, 2200)
          })()
        } else if (act === 'edit') {
          var rec = bucket(state.chatId)[idx]
          var next = prompt('编辑摘要：', rec ? rec.text : '')
          if (next === null) return
          if (rec) {
            rec.text = String(next).trim()
            rec.edited = true
            persist()
            pushInjection()
            renderList()
          }
        }
      })
    })
  }

  async function resummarizeAll() {
    if (state.busy) return
    if (!confirm('将重新总结当前会话的全部消息，已有摘要会被覆盖。继续？')) return
    state.busy = true
    renderStatus('重新总结中…')
    try {
      settings.summaries[state.chatId] = {}
      persist()
      for (var i = 0; i < state.messages.length; i++) {
        if (!String(state.messages[i].content || '').trim()) continue
        try {
          await summarizeOne(i)
        } catch (e) {
          /* 单条失败不中断整轮 */
        }
        renderStatus('重新总结中… ' + (i + 1) + '/' + state.messages.length)
      }
      renderStatus('重新总结完成')
      renderList()
      pushInjection()
    } finally {
      state.busy = false
      setTimeout(function () {
        renderStatus('')
      }, 2600)
    }
  }

  // ---------------------------------------------------------------- 上下文同步

  async function refreshContext() {
    var ctx = await API.getContext()
    if (!ctx) return
    var changed = ctx.chatId !== state.chatId
    state.chatId = ctx.chatId
    state.messages = Array.isArray(ctx.chat) ? ctx.chat : []
    if (changed) {
      state.cache = state.chatId ? bucket(state.chatId) : {}
    }
    ensureRoot()
    renderList()
    await registerInjection()
  }

  // ---------------------------------------------------------------- 事件

  function hookEvents() {
    var ET = API.event_types || {}

    // 多个事件都会导致"上下文变了"，若各自直接触发会导致一次回复里
    // 自动总结被并发调用多次（runAuto 内部虽有 autoRunning 守卫，
    // 但排队期间上下文已多次刷新，纯属浪费）。统一走防抖。
    var pend = null
    function scheduleRefresh() {
      if (pend) clearTimeout(pend)
      pend = setTimeout(function () {
        pend = null
        void refreshContext().then(function () {
          void runAuto()
        })
      }, 350)
    }

    ;[
      'MESSAGE_RECEIVED',
      'USER_MESSAGE_RENDERED',
      'CHARACTER_MESSAGE_RENDERED',
      'MESSAGE_EDITED',
      'MESSAGE_DELETED',
      'CHAT_CHANGED',
      'GENERATION_ENDED',
    ].forEach(function (name) {
      var ev = ET[name]
      if (ev && API.eventSource && typeof API.eventSource.on === 'function') {
        API.eventSource.on(ev, scheduleRefresh)
      }
    })
  }

  // 兜底：宿主事件未覆盖的情形（例如旧版本缺某些事件名），用轮询兜住。
  // 只在"会话 id 或消息数"变化时才刷新，平时几乎无开销。
  var lastSig = ''
  setInterval(function () {
    var sig = state.chatId + ':' + state.messages.length
    if (sig !== lastSig) {
      lastSig = sig
      void refreshContext().then(function () {
        void runAuto()
      })
    }
  }, 4000)

  // ---------------------------------------------------------------- 启动

  ;(async function boot() {
    try {
      ensureRoot()
      await refreshContext()
      hookEvents()
      renderStatus('就绪')
      setTimeout(function () {
        renderStatus('')
      }, 1500)
    } catch (e) {
      console.error('[ruxi-summarize] 启动失败', e)
      try {
        ensureRoot()
        renderStatus('启动失败：' + ((e && e.message) || e))
      } catch (_) {
        /* 连 UI 都建不起来就只能放弃 */
      }
    }
  })()
})()
