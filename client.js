/**
 * opencode-manage — 客户端半边。
 *
 * 会话标签行（对话 | 轨迹 | 上下文 | 编队 | 记忆系统 | …）末尾加一个「Go 余额」标签页。
 * 一个账号一张卡片，卡内三个环形表盘（5 小时 / 本周 / 本月）。
 * 只在标签被激活时挂载并拉一次，不常驻轮询。
 * 颜色规则：环形默认走品牌色，只有过阈值才切黄/红 —— 颜色是信号，不是装饰。
 */

window.__ModuleLoader__.load({
  id: 'opencode-manage',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.view'
    const SLOT_ID = 'opencode-usage'
    const STYLE_ID = 'opencode-manage-style'
    const API = '/opencode-usage/api'

    const WINDOWS = [
      { key: 'rolling', name: '5 小时', tone: 'rolling' },
      { key: 'weekly', name: '本周', tone: 'week' },
      { key: 'monthly', name: '本月', tone: 'month' },
    ]

    /** 桌面通知的三道线：跨过才算一次，掉回 85% 以下重新武装。 */
    const NOTIFY_TIERS = [85, 90, 98]
    const AUTO_KEY = 'opencode-manage:auto-minutes'
    /** 插件改名前的旧键：读到就搬到新键上，用户的间隔设置不用重设。 */
    const LEGACY_AUTO_KEY = 'dsh-opencode-usage:auto-minutes'

    function clampMinutes(raw) {
      const value = Number(raw)
      return Number.isFinite(value) && value > 0 ? Math.min(1440, Math.round(value)) : 0
    }

    function readAutoMinutesFrom(storage) {
      if (!storage) return 0
      const currentRaw = storage.getItem(AUTO_KEY)
      if (currentRaw !== null) return clampMinutes(currentRaw) // 显式设成 0 也算数，别被旧键复活
      const legacy = clampMinutes(storage.getItem(LEGACY_AUTO_KEY))
      if (legacy > 0) {
        try {
          storage.setItem(AUTO_KEY, String(legacy))
          storage.removeItem(LEGACY_AUTO_KEY)
        } catch {
          /* 搬迁失败不影响本次读取 */
        }
        return legacy
      }
      return 0
    }

    function readAutoMinutes() {
      try {
        return readAutoMinutesFrom(window.localStorage)
      } catch {
        return 0
      }
    }

    function autoNotice(minutes) {
      return COPY.notifyOn.replace('%d', String(minutes))
    }

    function writeAutoMinutes(value) {
      try {
        window.localStorage.setItem(AUTO_KEY, String(value))
      } catch {
        /* 存不了就只在本次会话生效 */
      }
    }

    /**
     * 自动刷新挂在模块上而不是组件里：切到别的标签页时组件会卸载，
     * 但设了间隔就应该继续拉、继续提醒。
     */
    const AUTO = { minutes: readAutoMinutes(), timer: null, tiers: new Map(), subscribers: new Set(), ticking: false }

    function notifySupported() {
      return typeof window !== 'undefined' && typeof window.Notification === 'function'
    }

    function askNotifyPermission(onDenied) {
      if (!notifySupported()) {
        onDenied()
        return
      }
      if (window.Notification.permission === 'granted') return
      if (window.Notification.permission === 'denied') {
        onDenied()
        return
      }
      try {
        window.Notification.requestPermission().then((value) => {
          if (value !== 'granted') onDenied()
        })
      } catch {
        onDenied()
      }
    }

    function pushNotification(account, meta, percent, tier, key) {
      const usage = account.usage ? account.usage[meta.key] : null
      const body = [
        `${account.label}｜${meta.name} ${Math.round(percent)}%`,
        usage && usage.resetsAt ? `重置 ${fmtReset(usage.resetsAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const notification = new window.Notification(`Go 余额：${meta.name} 到 ${tier}%`, {
        body,
        tag: `ocu:${key}:${tier}`,
      })
      notification.onclick = () => {
        try {
          window.focus()
        } catch {
          /* 忽略 */
        }
        notification.close()
      }
    }

    /** 只在开了自动刷新时提醒；跨过一道线报一次，掉回 85% 以下重新武装。 */
    function checkTiers(list) {
      if (!AUTO.minutes) return
      const canNotify = notifySupported() && window.Notification.permission === 'granted'
      for (const account of list) {
        if (!account || !account.ok || !account.usage) continue
        for (const meta of WINDOWS) {
          const value = account.usage[meta.key] ? account.usage[meta.key].percent : null
          if (typeof value !== 'number') continue
          const key = `${account.id}|${meta.key}`
          const previous = AUTO.tiers.get(key) || 0
          let tier = 0
          for (const line of NOTIFY_TIERS) if (value >= line) tier = line
          if (tier === previous) continue
          AUTO.tiers.set(key, tier)
          if (tier > previous && canNotify) pushNotification(account, meta, value, tier, key)
        }
      }
    }

    async function autoTick() {
      if (!AUTO.minutes || AUTO.ticking) return
      AUTO.ticking = true
      try {
        const payload = await api('/usage', { method: 'POST', body: '{}' })
        const list = Array.isArray(payload?.accounts) ? payload.accounts : []
        checkTiers(list)
        AUTO.subscribers.forEach((fn) => {
          try {
            fn(list, payload?.fetchedAt)
          } catch {
            /* 订阅者自己的问题，不影响别人 */
          }
        })
      } catch {
        /* 后台拉失败就等下一轮，界面上手动点「刷新全部」能看到错误 */
      } finally {
        AUTO.ticking = false
      }
    }

    function restartAutoTimer() {
      if (AUTO.timer) {
        window.clearInterval(AUTO.timer)
        AUTO.timer = null
      }
      if (AUTO.minutes > 0) AUTO.timer = window.setInterval(autoTick, AUTO.minutes * 60000)
    }

    function setAutoMinutes(value) {
      AUTO.minutes = value
      writeAutoMinutes(value)
      restartAutoTimer()
    }

    /* ---- 自动切号：模块级轮询，切到别的标签页也照样提醒 ---- */

    const ROUTER_POLL_MS = 60000
    const ROUTER_UI = { timer: null, status: null, seen: undefined, subscribers: new Set() }

    function notifySwitch(sw) {
      if (!notifySupported() || Notification.permission !== 'granted' || !sw) return
      const from = sw.from && sw.from.label ? `${sw.from.label} → ` : ''
      const to = sw.to && sw.to.label ? sw.to.label : '新 key'
      const tail = sw.to && sw.to.keyTail ? `（…${sw.to.keyTail}）` : ''
      try {
        const note = new Notification(`Go 自动切号：${to}`, {
          body: `${from}${to}${tail}${sw.reason ? ` · ${sw.reason}` : ''}`,
          tag: `ocu:switch:${sw.at || ''}`,
        })
        note.onclick = () => {
          try { window.focus() } catch { /* 忽略 */ }
          note.close()
        }
      } catch {
        /* 通知失败不影响页面 */
      }
    }

    function pushRouterStatus(status) {
      if (!status) return
      ROUTER_UI.status = status
      const at = status.lastSwitch ? status.lastSwitch.at : null
      if (ROUTER_UI.seen === undefined) {
        ROUTER_UI.seen = at
      } else if (at && at !== ROUTER_UI.seen) {
        ROUTER_UI.seen = at
        notifySwitch(status.lastSwitch)
      }
      ROUTER_UI.subscribers.forEach((fn) => {
        try { fn(status) } catch { /* 订阅方自己炸掉不该影响别的 */ }
      })
    }

    async function routerPoll() {
      try {
        pushRouterStatus(await api('/router'))
      } catch {
        /* 宿主还没重启时这里 404，静默等下一轮 */
      }
    }

    function startRouterPoll() {
      if (ROUTER_UI.timer) { routerPoll(); return }
      routerPoll()
      ROUTER_UI.timer = window.setInterval(routerPoll, ROUTER_POLL_MS)
    }

    const COPY = {
      tab: 'Go 余额',
      title: 'Go 余额',
      refresh: '刷新全部',
      refreshing: '刷新中…',
      add: '添加账号',
      addHint: '手填一个 oc_sk_ 开头的 key',
      save: '保存',
      saveBusy: '保存中…',
      cancel: '取消',
      nameLabel: '名称',
      namePlaceholder: '例如：go163 备用',
      keyLabel: 'API Key',
      keyPlaceholder: 'oc_sk_…',
      remove: '删除',
      removeConfirm: '确认删除',
      edit: '编辑',
      keyKeep: '留空不改',
      noteManual: '只改这一条手填记录；key 存在本机 accounts.json（0600）。',
      noteManualShort: '正在编辑…',
      noteConfig: '改名只影响这一页显示；换 key 会写回 DSH 凭据里的同一个 ref。',
      empty: '还没有认到任何 OpenCode Go 账号',
      emptyHint: '在 DSH 模型设置里加 OpenCode Go provider，或手填一个 key。',
      loading: '正在拉取…',
      lastRefresh: '上次刷新',
      sourceConfig: 'DSH 配置',
      sourceCredential: '凭据库',
      sourceManual: '手填',
      noKey: '没找到 key',
      keyRejected: 'Key 被拒',
      badKey: 'key 要以 oc_ 开头，检查一下再存。',
      duplicate: '这个 key 已经在列表里了。',
      hostStale: '宿主还没重启：保存/删除需要重启一次 DSH（只刷新本页不够）。',
      autoLabel: '自动刷新',
      autoUnit: '分钟',
      autoHint: '0 = 关闭。设为 N 分钟就每 N 分钟自动拉一次，并在 85% / 90% / 98% 各弹一次桌面通知。',
      notifyOn: '已开自动刷新：每 %d 分钟拉一次；用量跨过 85% / 90% / 98% 会弹桌面通知。',
      notifyBlocked: '浏览器没给通知权限，只在页面里提示。要桌面通知，去地址栏左边的站点设置里允许通知。',
      routerTitle: '自动切号',
      routerOn: '开着',
      routerOff: '关着',
      routerNow: '当前用',
      routerIdle: '还没选号',
      routerCheck: '立即检查',
      routerChecking: '检查中…',
      routerToggleOn: '开启',
      routerToggleOff: '关闭',
      routerLast: '上次换号',
      routerBlocked: '停用',
      routerHint: '每 5 分钟在后台看一眼 5 小时/周/月额度：谁先重置用谁；5 小时或周额度到 99.9% 换下一个；月额度到 100% 停用到下个重置日。点某个账号可以直接切过去。',
      routerModelHint: '模型列表里的「OpenCode Go 自动」用这份 key，换号下一次请求就生效。',
      routerManual: '手动',
      routerManualOn: '手动指定中',
      routerBackAuto: '回到自动',
      routerPickHint: '点一下立即切到这个账号（手动指定，自动逻辑不再抢；它自己爆额度或你点「回到自动」才交回）',
      routerManualDropped: '手动指定的号不可用了，已回到自动',
      routerSwitched: '已换号',
      routerSame: '不用换',
      routerCheckedAt: '检查于',
      cardActive: '在用',
      ok: '正常',
      warn: '接近上限',
      danger: '快用完',
      fail: '出错',
      fetched: '拉取',
      footnote:
        '5 小时窗口 = 月额度的 20%，每周 = 50%，每月 = 100%。重置时间按本机时区。',
    }

    /* ---------------- 小工具 ---------------- */

    const pad = (n) => String(n).padStart(2, '0')

    function fmtReset(iso) {
      if (!iso) return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      const now = new Date()
      const dayDiff = Math.round(
        (new Date(at.getFullYear(), at.getMonth(), at.getDate()) -
          new Date(now.getFullYear(), now.getMonth(), now.getDate())) /
          86400000,
      )
      const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
      if (dayDiff === 0) return `今天 ${time}`
      if (dayDiff === 1) return `明天 ${time}`
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
    }

    function fmtClock(iso) {
      if (!iso) return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    }

    function levelOf(percent) {
      if (typeof percent !== 'number') return 'idle'
      if (percent >= 90) return 'danger'
      if (percent >= 70) return 'warn'
      return 'ok'
    }

    const LEVEL_RANK = { idle: 0, ok: 1, warn: 2, danger: 3 }

    function worstLevel(account) {
      if (!account.ok || !account.usage) return 'idle'
      let level = 'ok'
      for (const meta of WINDOWS) {
        const next = levelOf(account.usage[meta.key] ? account.usage[meta.key].percent : null)
        if (LEVEL_RANK[next] > LEVEL_RANK[level]) level = next
      }
      return level
    }

    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const code = payload?.error?.code || payload?.code || ''
        const text =
          code === 'BAD_KEY'
            ? COPY.badKey
            : code === 'DUPLICATE'
              ? COPY.duplicate
              : payload?.message || (response.status === 404 ? COPY.hostStale : `HTTP ${response.status}`)
        const error = new Error(text)
        error.code = code
        throw error
      }
      return payload
    }

    /* ---------------- 样式 ---------------- */

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.ocu-root {
  height: 100%;
  overflow: auto;
  padding: 26px 30px 60px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.ocu-inner { width: 100%; max-width: 1180px; margin: 0 auto; }

/* 页头 */
.ocu-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.ocu-title { font-size: 16px; font-weight: 600; letter-spacing: .2px; }
.ocu-count { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.ocu-stamp { margin-top: 5px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ocu-actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }
.ocu-actions .ocu-btn { min-width: 86px; }

/* 自动刷新：数字框 + 单位 */
.ocu-auto {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px 0 11px;
  border-radius: 8px; border: 1px solid transparent;
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  transition: border-color .12s ease, background .12s ease;
}
.ocu-auto:hover { border-color: var(--dsw-alias-border-l1); }
.ocu-auto-label { color: var(--dsw-alias-label-secondary); }
.ocu-auto-input {
  width: 44px; height: 22px; padding: 0 4px; text-align: center;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 12px; font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.ocu-auto-input::-webkit-outer-spin-button,
.ocu-auto-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ocu-auto-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.ocu-auto.off .ocu-auto-input { color: var(--dsw-alias-label-tertiary); }

.ocu-btn {
  height: 30px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.ocu-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ocu-btn:active { background: var(--dsw-alias-interactive-bg-active); }
.ocu-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ocu-btn[disabled] { opacity: .5; cursor: default; }
.ocu-btn.primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-inverted); }
.ocu-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.ocu-btn.ghost { height: 26px; padding: 0 8px; background: transparent; border-color: transparent; color: var(--dsw-alias-label-tertiary); }
.ocu-btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ocu-btn.ghost.danger:hover { color: var(--dsw-alias-state-error-primary); }

/* 卡片网格 */
.ocu-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(272px, 1fr)); gap: 14px; }

.ocu-card {
  position: relative;
  display: flex; flex-direction: column;
  padding: 15px 16px 13px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .05);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.ocu-card:hover { border-color: var(--dsw-alias-border-l2); box-shadow: 0 4px 14px rgba(0, 0, 0, .10); }
.ocu-card.is-warn::before,
.ocu-card.is-danger::before {
  content: ''; position: absolute; left: 0; top: 15px; bottom: 13px; width: 3px;
  border-radius: 0 3px 3px 0;
}
.ocu-card.is-warn::before { background: var(--dsw-alias-state-warn-primary); }
.ocu-card.is-danger::before { background: var(--dsw-alias-state-error-primary); }
.ocu-card.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 26%, var(--dsw-alias-border-l1)); }
.ocu-card.is-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 26%, var(--dsw-alias-border-l1)); }

.ocu-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-height: 34px; }
.ocu-identity { min-width: 0; }
.ocu-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ocu-name {
  min-width: 0; max-width: 100%;
  font-size: 13.5px; font-weight: 600; line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ocu-name-more {
  flex-shrink: 0; height: 16px; padding: 0 5px; border-radius: 999px;
  display: inline-flex; align-items: center;
  font-size: 10px; font-weight: 600; letter-spacing: .2px;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}
.ocu-name-input {
  width: 100%; height: 24px; padding: 0 6px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px; font-family: inherit;
}
.ocu-meta { margin-top: 3px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); display: flex; gap: 6px; align-items: center; }
.ocu-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .2px; }

.ocu-pill {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 8px; border-radius: 999px;
  font-size: 10.5px; font-weight: 500; white-space: nowrap;
}
.ocu-pill.is-ok { color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.ocu-pill.is-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.ocu-pill.is-danger, .ocu-pill.is-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.ocu-pill.is-idle { color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }

/* 三个表盘 */
.ocu-gauges { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 12px 0 4px; }
.ocu-gauge { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.ocu-gauge-ring { position: relative; width: 72px; height: 72px; }
.ocu-gauge-ring svg { display: block; width: 72px; height: 72px; transform: rotate(-90deg); }
.ocu-gauge-track { fill: none; stroke: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent); stroke-width: 5; }
.ocu-gauge-arc { fill: none; stroke: var(--dsw-alias-state-business-primary); stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray .45s ease, stroke .2s ease; }
.ocu-gauge[data-tone="week"] .ocu-gauge-arc { stroke: var(--dsw-alias-state-success-primary); }
.ocu-gauge[data-tone="month"] .ocu-gauge-arc { stroke: var(--dsw-static-violet-600); }
.ocu-gauge.is-warn .ocu-gauge-arc { stroke: var(--dsw-alias-state-warn-primary); }
.ocu-gauge.is-danger .ocu-gauge-arc { stroke: var(--dsw-alias-state-error-primary); }
.ocu-gauge.is-idle .ocu-gauge-arc { stroke: var(--dsw-alias-state-idle-primary); }
.ocu-gauge-value {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 16.5px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.ocu-gauge.is-warn .ocu-gauge-value { color: var(--dsw-alias-state-warn-primary); }
.ocu-gauge.is-danger .ocu-gauge-value { color: var(--dsw-alias-state-error-primary); }
.ocu-gauge-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ocu-gauge-reset { font-size: 10px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; height: 13px; }

.ocu-card-foot {
  margin-top: auto; padding-top: 10px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
}
.ocu-card-actions { display: flex; gap: 2px; }
.ocu-error { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.ocu-error-note { margin-top: 2px; color: var(--dsw-alias-label-tertiary); }

/* 空态 / 加载 */
.ocu-skeleton {
  min-height: 196px; padding: 16px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  display: flex; flex-direction: column; gap: 12px;
  animation: ocu-pulse 1.5s ease-in-out infinite;
}
.ocu-sk-line { height: 10px; border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.ocu-sk-line.w60 { width: 60%; }
.ocu-sk-line.w34 { width: 34%; height: 8px; }
.ocu-sk-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 4px; }
.ocu-sk-ring { width: 58px; height: 58px; border-radius: 50%; margin: 0 auto; background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.ocu-sk-line.short { width: 46%; margin: 0 auto; }
@keyframes ocu-pulse { 0%, 100% { opacity: .45 } 50% { opacity: .8 } }

/* 添加账号：虚线卡片 */
.ocu-ghost {
  min-height: 152px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px; font-family: inherit; cursor: pointer;
  transition: border-color .15s ease, background .15s ease, color .15s ease;
}
.ocu-ghost:hover { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ocu-ghost:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ocu-ghost-plus { font-size: 20px; line-height: 1; font-weight: 300; }
.ocu-ghost-hint { font-size: 10.5px; }

/* 空态 */
.ocu-empty-card {
  grid-column: 1 / -1;
  display: flex; flex-direction: column; align-items: center; gap: 9px;
  padding: 42px 20px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 14px;
}
.ocu-empty-title { font-size: 13px; color: var(--dsw-alias-label-secondary); }

/* 添加账号：表单卡片 */
.ocu-form-card { display: flex; flex-direction: column; gap: 9px; padding: 15px 16px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); }
.ocu-field { display: flex; flex-direction: column; gap: 4px; }
.ocu-field label { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.ocu-field input {
  height: 28px; padding: 0 8px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; font-family: inherit;
}
.ocu-field input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.ocu-form-actions { display: flex; gap: 6px; margin-top: 2px; }
.ocu-edit { display: flex; flex-direction: column; gap: 8px; padding: 10px 0 2px; }
.ocu-edit-note { font-size: 10.5px; line-height: 1.45; color: var(--dsw-alias-label-tertiary); }
.ocu-edit-actions { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
.ocu-edit-actions .ocu-btn.danger { margin-left: auto; }
.ocu-msg { font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.ocu-msg.is-note {
  margin: 0 0 12px; padding: 7px 10px; border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
}

.ocu-foot { margin-top: 18px; display: flex; justify-content: space-between; gap: 16px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }

.ocu-router {
  margin: 0 0 14px; padding: 10px 12px; border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent);
}
.ocu-router.off {
  border-color: var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}
.ocu-router-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.ocu-router-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
}
.ocu-router.off .ocu-router-dot { background: var(--dsw-alias-label-tertiary); box-shadow: none; }
.ocu-router-name { font-weight: 600; }
.ocu-router-state { color: var(--dsw-alias-label-secondary); }
.ocu-router-sep { color: var(--dsw-alias-label-tertiary); }
.ocu-router-active { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.ocu-router-time { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ocu-router-actions { display: flex; gap: 6px; }
.ocu-queue { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ocu-chip {
  display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px;
  font-family: inherit; font-size: 11px; line-height: 1.5; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}
.ocu-chip.is-active {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, transparent);
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
.ocu-chip.is-blocked { opacity: .5; }
.ocu-chip.is-clickable { cursor: pointer; }
.ocu-chip.is-clickable:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);
  color: var(--dsw-alias-label-primary);
}
.ocu-chip.is-clickable:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.ocu-chip.is-manual { border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent); }
.ocu-chip-tag.is-manual { color: var(--dsw-alias-state-business-primary); }
.ocu-chip-no { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.ocu-chip-num { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.ocu-chip-tag { color: var(--dsw-alias-state-error-primary); font-size: 10px; }
.ocu-router-last { margin-top: 7px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ocu-auto-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 999px; white-space: nowrap;
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .ocu-gauge-arc, .ocu-card, .ocu-btn, .ocu-ghost { transition: none; }
  .ocu-skeleton { animation: none; }
}
`
      document.head.appendChild(style)
    }

    /* ---------------- 组件 ---------------- */

    const RADIUS = 30
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS

    function Gauge({ meta, data }) {
      const percent = data && typeof data.percent === 'number' ? data.percent : null
      const level = levelOf(percent)
      const filled = percent === null ? 0 : (CIRCUMFERENCE * Math.min(100, Math.max(0, percent))) / 100
      return h(
        'div',
        { className: `ocu-gauge is-${level}`, 'data-tone': meta.tone },
        h(
          'div',
          {
            className: 'ocu-gauge-ring',
            role: 'img',
            'aria-label': `${meta.name}：${percent === null ? '无数据' : fmtPct(percent) + ' 已用'}`,
          },
          h(
            'svg',
            { viewBox: '0 0 72 72' },
            h('circle', { className: 'ocu-gauge-track', cx: 36, cy: 36, r: RADIUS }),
            h('circle', {
              className: 'ocu-gauge-arc',
              cx: 36,
              cy: 36,
              r: RADIUS,
              strokeDasharray: `${filled} ${CIRCUMFERENCE - filled}`,
            }),
          ),
          h('span', { className: 'ocu-gauge-value' }, fmtPct(percent)),
        ),
        h('span', { className: 'ocu-gauge-label' }, meta.name),
        h('span', { className: 'ocu-gauge-reset' }, data && data.resetsAt ? fmtReset(data.resetsAt) : ''),
      )
    }

    function EditPanel({ account, onCancel, onSaved }) {
      const manual = account.source === 'manual'
      const [label, setLabel] = React.useState(account.label)
      const [key, setKey] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          await api('/accounts/update', {
            method: 'POST',
            body: JSON.stringify({ id: account.id, label: label.trim(), key: key.trim() }),
          })
          onSaved()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }

      const keyPlaceholder = account.keyTail ? `${COPY.keyKeep}（当前 …${account.keyTail}）` : COPY.keyPlaceholder

      return h(
        'div',
        { className: 'ocu-edit' },
        h(
          'div',
          { className: 'ocu-field' },
          h('label', null, COPY.nameLabel),
          h('input', {
            autoFocus: true,
            value: label,
            onChange: (event) => setLabel(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') onCancel()
            },
          }),
        ),
        h(
          'div',
          { className: 'ocu-field' },
          h('label', null, COPY.keyLabel),
          h('input', {
            type: 'password',
            value: key,
            placeholder: keyPlaceholder,
            onChange: (event) => setKey(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') onCancel()
            },
          }),
        ),
        h('div', { className: 'ocu-edit-note' }, manual ? COPY.noteManual : COPY.noteConfig),
        error ? h('div', { className: 'ocu-msg' }, error) : null,
        h(
          'div',
          { className: 'ocu-edit-actions' },
          h('button', { className: 'ocu-btn primary', disabled: busy, onClick: submit }, busy ? COPY.saveBusy : COPY.save),
          h('button', { className: 'ocu-btn', disabled: busy, onClick: onCancel }, COPY.cancel),
        ),
      )
    }

    function AccountCard({ account, active, onRemove, onSaved, onRetry }) {
      const [editing, setEditing] = React.useState(false)
      const [confirming, setConfirming] = React.useState(false)
      const level = worstLevel(account)
      const manual = account.source === 'manual'
      const nameParts = String(account.label || '').split(' / ')
      const primaryName = nameParts[0]
      const mergedCount = nameParts.length - 1
      const originalName = account.autoLabel && account.autoLabel !== account.label ? `（原名 ${account.autoLabel}）` : ''

      const pill = account.ok
        ? level === 'warn'
          ? { cls: 'is-warn', text: COPY.warn }
          : level === 'danger'
            ? { cls: 'is-danger', text: COPY.danger }
            : { cls: 'is-ok', text: COPY.ok }
        : { cls: 'is-error', text: account.error === 'KEY_REJECTED' ? COPY.keyRejected : COPY.fail }

      return h(
        'article',
        { className: `ocu-card is-${account.ok ? level : 'error'}` },
        h(
          'div',
          { className: 'ocu-card-head' },
          h(
            'div',
            { className: 'ocu-identity' },
            h(
              'span',
              {
                className: 'ocu-name-line',
                title: `${account.label}${originalName}（双击编辑）`,
                onDoubleClick: () => setEditing(true),
              },
              h('span', { className: 'ocu-name' }, primaryName),
              mergedCount > 0
                ? h('span', { className: 'ocu-name-more', title: account.label }, `+${mergedCount}`)
                : null,
            ),
            h(
              'span',
              { className: 'ocu-meta' },
              h('span', null, account.source === 'config' ? COPY.sourceConfig : account.source === 'manual' ? COPY.sourceManual : COPY.sourceCredential),
              h('span', { className: 'ocu-key' }, account.keyTail ? `…${account.keyTail}` : COPY.noKey),
              active ? h('span', { className: 'ocu-auto-tag', title: COPY.routerModelHint }, COPY.cardActive) : null,
            ),
          ),
          h('span', { className: `ocu-pill ${pill.cls}` }, pill.text),
        ),
        editing
          ? h(EditPanel, {
              account,
              onCancel: () => setEditing(false),
              onSaved: () => {
                setEditing(false)
                onSaved()
              },
            })
          : account.ok
            ? h('div', { className: 'ocu-gauges' }, WINDOWS.map((meta) => h(Gauge, { key: meta.key, meta, data: account.usage ? account.usage[meta.key] : null })))
            : h(
                'div',
                { style: { padding: '22px 0 18px' }, className: 'ocu-error' },
                account.error === 'KEY_REJECTED' ? COPY.keyRejected : account.message || COPY.fail,
                h('div', { className: 'ocu-error-note' }, manual ? '点右下角「编辑」换一个 key' : '点右下角「编辑」换一个 key，或去 DSH 凭据里改'),
                account.error === 'KEY_REJECTED'
                  ? null
                  : h('button', { className: 'ocu-btn ghost', style: { marginTop: '8px', paddingLeft: 0 }, onClick: onRetry }, '重试'),
              ),
        h(
          'div',
          { className: 'ocu-card-foot' },
          h('span', null, account.fetchedAt ? `${COPY.fetched} ${fmtClock(account.fetchedAt)}` : ''),
          editing
            ? h('span', null, manual ? COPY.noteManualShort : '')
            : h(
                'span',
                { className: 'ocu-card-actions' },
                h('button', { className: 'ocu-btn ghost', onClick: () => setEditing(true) }, COPY.edit),
                manual
                  ? confirming
                    ? [
                        h('button', { key: 'yes', className: 'ocu-btn ghost danger', onClick: () => onRemove(account) }, COPY.removeConfirm),
                        h('button', { key: 'no', className: 'ocu-btn ghost', onClick: () => setConfirming(false) }, COPY.cancel),
                      ]
                    : h('button', { key: 'del', className: 'ocu-btn ghost danger', onClick: () => setConfirming(true) }, COPY.remove)
                  : null,
              ),
        ),
      )
    }

    function AddCard({ onCancel, onSaved }) {
      const [label, setLabel] = React.useState('')
      const [key, setKey] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const submit = async () => {
        if (!key.trim()) {
          setError(COPY.keyPlaceholder)
          return
        }
        setBusy(true)
        setError('')
        try {
          await api('/accounts', { method: 'POST', body: JSON.stringify({ label, key }) })
          onSaved()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'ocu-form-card' },
        h(
          'div',
          { className: 'ocu-field' },
          h('label', { htmlFor: 'ocu-label' }, COPY.nameLabel),
          h('input', {
            id: 'ocu-label',
            value: label,
            placeholder: COPY.namePlaceholder,
            onChange: (event) => setLabel(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'ocu-field' },
          h('label', { htmlFor: 'ocu-key' }, COPY.keyLabel),
          h('input', {
            id: 'ocu-key',
            value: key,
            placeholder: COPY.keyPlaceholder,
            type: 'password',
            onChange: (event) => setKey(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
            },
          }),
        ),
        error ? h('div', { className: 'ocu-msg' }, error) : null,
        h(
          'div',
          { className: 'ocu-form-actions' },
          h('button', { className: 'ocu-btn primary', disabled: busy, onClick: submit }, busy ? COPY.saveBusy : COPY.save),
          h('button', { className: 'ocu-btn', disabled: busy, onClick: onCancel }, COPY.cancel),
        ),
      )
    }

    function fmtPct(value) {
      if (value == null) return '—'
      const rounded = Math.round(value * 10) / 10
      return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`
    }

    function RouterBar({ status, busy, onTick, onToggle, onPick, picking }) {
      if (!status) return null
      const on = status.enabled !== false
      const rows = status.lastCheck && Array.isArray(status.lastCheck.rows) ? status.lastCheck.rows : []
      const activeId = status.activeId || ''
      const manualId = status.manualId || ''

      return h(
        'div',
        { className: on ? 'ocu-router' : 'ocu-router off' },
        h(
          'div',
          { className: 'ocu-router-main' },
          h('span', { className: 'ocu-router-dot' }),
          h('span', { className: 'ocu-router-name' }, COPY.routerTitle),
          h('span', { className: 'ocu-router-state' }, on ? COPY.routerOn : COPY.routerOff),
          manualId ? h('span', { className: 'ocu-chip-tag is-manual' }, COPY.routerManualOn) : null,
          h('span', { className: 'ocu-router-sep' }, '·'),
          h(
            'span',
            { className: 'ocu-router-active' },
            status.activeLabel
              ? `${COPY.routerNow} ${status.activeLabel}${status.activeKeyTail ? ` …${status.activeKeyTail}` : ''}`
              : COPY.routerIdle,
          ),
          h('span', { className: 'ocu-router-time', title: COPY.routerModelHint }, status.checkedAt ? `${COPY.routerCheckedAt} ${fmtClock(status.checkedAt)}` : ''),
          h(
            'div',
            { className: 'ocu-router-actions' },
            h('button', { className: 'ocu-btn', disabled: busy, onClick: onTick, title: COPY.routerHint }, busy ? COPY.routerChecking : COPY.routerCheck),
            h('button', { className: 'ocu-btn', onClick: onToggle }, on ? COPY.routerToggleOff : COPY.routerToggleOn),
            manualId
              ? h('button', { className: 'ocu-btn', disabled: picking, onClick: () => onPick('') }, COPY.routerBackAuto)
              : null,
          ),
        ),
        rows.length
          ? h(
              'div',
              { className: 'ocu-queue' },
              rows.map((row, index) =>
                h(
                  'button',
                  {
                    key: row.id,
                    type: 'button',
                    disabled: picking,
                    className: [
                      'ocu-chip',
                      'is-clickable',
                      row.blocked ? 'is-blocked' : '',
                      row.id === activeId ? 'is-active' : '',
                      row.id === manualId ? 'is-manual' : '',
                    ]
                      .filter(Boolean)
                      .join(' '),
                    title: row.blocked ? `${row.reason}（也可以点，切过去会立刻报错）` : COPY.routerPickHint,
                    onClick: () => onPick(row.id === manualId ? '' : row.id),
                  },
                  h('span', { className: 'ocu-chip-no' }, String(index + 1)),
                  h('span', null, row.label),
                  h('span', { className: 'ocu-chip-num' }, `5h${fmtPct(row.rolling)} · 周${fmtPct(row.weekly)} · 月${fmtPct(row.monthly)}`),
                  row.blocked ? h('span', { className: 'ocu-chip-tag' }, COPY.routerBlocked) : null,
                  row.id === manualId ? h('span', { className: 'ocu-chip-tag is-manual' }, COPY.routerManual) : null,
                ),
              ),
            )
          : null,
        status.lastSwitch
          ? h(
              'div',
              { className: 'ocu-router-last' },
              `${COPY.routerLast} ${fmtClock(status.lastSwitch.at)} · ${status.lastSwitch.from ? status.lastSwitch.from.label : '—'} → ${status.lastSwitch.to ? status.lastSwitch.to.label : ''}`,
            )
          : null,
      )
    }

    function UsageView() {
      const [rows, setRows] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [fetchedAt, setFetchedAt] = React.useState('')
      const [adding, setAdding] = React.useState(false)
      const [autoMin, setAutoMin] = React.useState(() => AUTO.minutes)
      const [autoText, setAutoText] = React.useState(() => String(AUTO.minutes))
      const [notice, setNotice] = React.useState(() => (AUTO.minutes > 0 ? autoNotice(AUTO.minutes) : ''))
      const [router, setRouter] = React.useState(() => ROUTER_UI.status)
      const [routerBusy, setRouterBusy] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const mountedRef = React.useRef(true)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const payload = await api('/usage', { method: 'POST', body: '{}' })
          if (!mountedRef.current) return
          const list = Array.isArray(payload?.accounts) ? payload.accounts : []
          setRows(list)
          setFetchedAt(payload?.fetchedAt || new Date().toISOString())
          checkTiers(list)
        } catch (err) {
          if (!mountedRef.current) return
          setError(String(err?.message || err))
        } finally {
          if (mountedRef.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      // 后台自动刷新拉到新数据时，页面上这一份跟着更新。
      React.useEffect(() => {
        const onAuto = (list, at) => {
          if (!mountedRef.current) return
          setRows(list)
          if (at) setFetchedAt(at)
        }
        AUTO.subscribers.add(onAuto)
        return () => AUTO.subscribers.delete(onAuto)
      }, [])

      // 手动指定的号失效（比如自己爆了额度）时，宿主会把标记清掉并留痕，这里提示一句
      React.useEffect(() => {
        if (router && router.manualDropped && router.manualDropped.at) {
          setNotice(`${COPY.routerManualDropped}（${router.manualDropped.label || ''}${router.manualDropped.reason ? `：${router.manualDropped.reason}` : ''}）`)
        }
      }, [router && router.manualDropped && router.manualDropped.at])

      // 自动切号状态：进页面先拿一次，之后每 60 秒跟一次；换号会弹通知。
      React.useEffect(() => {
        const onStatus = (status) => {
          if (!mountedRef.current) return
          setRouter(status)
        }
        ROUTER_UI.subscribers.add(onStatus)
        startRouterPoll()
        if (ROUTER_UI.status) setRouter(ROUTER_UI.status)
        return () => ROUTER_UI.subscribers.delete(onStatus)
      }, [])

      /* ---- 自动刷新与桌面通知 ---- */

      function commitAuto(event) {
        const raw = event && event.target ? event.target.value : event
        const digits = String(raw).replace(/[^\d]/g, '')
        setAutoText(digits)
        const value = digits === '' ? 0 : Math.min(1440, Number(digits))
        setAutoMin(value)
        setAutoMinutes(value)
        setNotice(value > 0 ? autoNotice(value) : '')
        if (value > 0) askNotifyPermission(() => setNotice(COPY.notifyBlocked))
      }

      const routerTick = async () => {
        setRouterBusy(true)
        try {
          const status = await api('/router/tick', { method: 'POST', body: '{}' })
          pushRouterStatus(status)
          await load()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          if (mountedRef.current) setRouterBusy(false)
        }
      }

      const routerToggle = async () => {
        try {
          const enabled = !(router && router.enabled !== false)
          const status = await api('/router/enabled', { method: 'POST', body: JSON.stringify({ enabled }) })
          pushRouterStatus(status)
        } catch (err) {
          setError(String(err?.message || err))
        }
      }

      const routerPick = async (id) => {
        setPicking(true)
        try {
          const status = await api('/router/manual', { method: 'POST', body: JSON.stringify({ id }) })
          pushRouterStatus(status)
          await load()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          if (mountedRef.current) setPicking(false)
        }
      }

      const remove = async (account) => {
        try {
          await api('/accounts/remove', { method: 'POST', body: JSON.stringify({ id: account.id }) })
          await load()
        } catch (err) {
          setError(String(err?.message || err))
        }
      }

      const accounts = rows || []

      return h(
        'div',
        { className: 'ocu-root' },
        h(
          'div',
          { className: 'ocu-inner' },
          h(
            'div',
            { className: 'ocu-head' },
            h(
              'div',
              null,
              h(
                'div',
                { className: 'ocu-title' },
                COPY.title,
                rows === null ? null : h('span', { className: 'ocu-count' }, `${accounts.length} 个账号`),
              ),
              h('div', { className: 'ocu-stamp' }, fetchedAt ? `${COPY.lastRefresh} ${fmtClock(fetchedAt)}` : '\u00a0'),
            ),
            h(
              'div',
              { className: 'ocu-actions' },
              h(
                'label',
                { className: autoMin > 0 ? 'ocu-auto' : 'ocu-auto off', title: COPY.autoHint },
                h('span', { className: 'ocu-auto-label' }, COPY.autoLabel),
                h('input', {
                  className: 'ocu-auto-input',
                  type: 'number',
                  min: 0,
                  max: 1440,
                  step: 1,
                  value: autoText,
                  onChange: (event) => commitAuto(event.target.value),
                }),
                h('span', { className: 'ocu-auto-unit' }, COPY.autoUnit),
              ),
              h('button', { className: 'ocu-btn', disabled: loading, onClick: load }, COPY.refresh),
              h(
                'button',
                { className: 'ocu-btn primary', onClick: () => setAdding(true), disabled: adding },
                COPY.add,
              ),
            ),
          ),
          error ? h('div', { className: 'ocu-msg', style: { margin: '0 0 12px' } }, `${COPY.fail}：${error}`) : null,
          notice ? h('div', { className: 'ocu-msg is-note' }, notice) : null,
          h(RouterBar, {
            status: router,
            busy: routerBusy,
            picking,
            onTick: routerTick,
            onToggle: routerToggle,
            onPick: routerPick,
          }),
          h(
            'div',
            { className: 'ocu-grid' },
            rows !== null && accounts.length === 0 && !adding
              ? h(
                  'div',
                  { className: 'ocu-empty-card' },
                  h('div', { className: 'ocu-empty-title' }, COPY.empty),
                  h('div', { className: 'ocu-ghost-hint' }, COPY.emptyHint),
                  h('button', { className: 'ocu-btn primary', onClick: () => setAdding(true) }, COPY.add),
                )
              : null,
            rows === null
              ? [0, 1, 2].map((index) =>
                  h(
                    'div',
                    { key: index, className: 'ocu-skeleton' },
                    h('div', { className: 'ocu-sk-line w60' }),
                    h('div', { className: 'ocu-sk-line w34' }),
                    h(
                      'div',
                      { className: 'ocu-sk-row' },
                      [0, 1, 2].map((cell) =>
                        h(
                          'div',
                          { key: cell, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                          h('div', { className: 'ocu-sk-ring' }),
                          h('div', { className: 'ocu-sk-line short' }),
                        ),
                      ),
                    ),
                  ),
                )
              : accounts.map((account) =>
                  h(AccountCard, {
                    key: account.id,
                    account,
                    active: Boolean(router && router.activeId === account.id),
                    onRemove: remove,
                    onSaved: load,
                    onRetry: load,
                  }),
                ),
            adding
              ? h(AddCard, {
                  onCancel: () => setAdding(false),
                  onSaved: () => {
                    setAdding(false)
                    load()
                  },
                })
              : rows !== null && accounts.length === 0
                ? null
                : h(
                    'button',
                    { className: 'ocu-ghost', onClick: () => setAdding(true) },
                    h('span', { className: 'ocu-ghost-plus' }, '+'),
                    h('span', null, COPY.add),
                    h('span', { className: 'ocu-ghost-hint' }, COPY.addHint),
                  ),
          ),
          h(
            'div',
            { className: 'ocu-foot' },
            h('span', null, COPY.footnote),
            h('span', null, loading && rows !== null ? COPY.loading : ''),
          ),
        ),
      )
    }

    /* ---------------- 注册 ---------------- */

    function apply(ctx) {
      ensureStyle()
      restartAutoTimer()
      startRouterPoll()
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: SLOT_ID,
            order: 50,
            label: () => COPY.tab,
          },
          UsageView,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
