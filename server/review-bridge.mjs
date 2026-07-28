const REVIEW_BRIDGE_SCRIPT = String.raw`(() => {
  'use strict'

  function memoryStorage() {
    const values = new Map()
    return {
      get length() { return values.size },
      key(index) { return [...values.keys()][index] ?? null },
      getItem(key) {
        const normalized = String(key)
        return values.has(normalized) ? values.get(normalized) : null
      },
      setItem(key, value) { values.set(String(key), String(value)) },
      removeItem(key) { values.delete(String(key)) },
      clear() { values.clear() },
    }
  }

  function installStorageShim(name) {
    try {
      const storage = window[name]
      const probe = '__prototype_review_storage_probe__'
      storage.setItem(probe, probe)
      storage.removeItem(probe)
      return
    } catch {}
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        value: memoryStorage(),
      })
    } catch {}
  }

  installStorageShim('localStorage')
  installStorageShim('sessionStorage')

  const CONNECT_CHANNEL = 'prototype-review-bridge-connect'
  const HOST_CHANNEL = 'prototype-review-host-port'
  const BRIDGE_CHANNEL = 'prototype-review-bridge-port'
  const VERSION = 1
  const MAX_REQUEST_ID = 80
  const MAX_SELECTOR = 2000
  const MAX_ITEMS = 100
  const MAX_ITEM_ID = 160
  const MAX_HREF = 4096
  const stableAttributes = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'name', 'aria-label']
  let parentOrigin = ''
  try { parentOrigin = new URL(document.referrer).origin } catch {}
  const targetOrigin = parentOrigin && parentOrigin !== 'null' ? parentOrigin : '*'
  let activePort = null
  let activePostMessage = null
  let connectTimer = 0
  const offeredPorts = new Set()

  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const finite = (value) => typeof value === 'number' && Number.isFinite(value)
  const shortString = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum
  const href = () => String(location.href).slice(0, MAX_HREF)
  const viewport = () => ({ width: innerWidth, height: innerHeight })
  const compactText = (value) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+\d+\s*$/, '')
    .slice(0, 80)
  const identityText = (element) => compactText(
    element.getAttribute('data-page-key')
    || element.getAttribute('data-route')
    || element.getAttribute('href')
    || element.getAttribute('aria-label')
    || element.textContent
  )

  function isVisible(element) {
    if (!(element instanceof Element)) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  function viewIdentity() {
    const activeSelectors = [
      '[aria-current="page"]',
      '[role="tab"][aria-selected="true"]',
      '.nav-item.active',
      '.menu-item.active',
      '.ant-menu-item-selected',
      '.el-menu-item.is-active',
      'nav .active',
      'aside .active',
    ]
    const active = []
    for (const selector of activeSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isVisible(element)) continue
        const text = identityText(element)
        if (text && !active.includes(text)) active.push(text)
        if (active.length >= 4) break
      }
      if (active.length >= 4) break
    }
    const headings = []
    for (const element of document.querySelectorAll('main h1, main h2, [role="main"] h1, [role="main"] h2, h1')) {
      if (!isVisible(element)) continue
      const text = compactText(element.textContent)
      if (text && !headings.includes(text)) headings.push(text)
      if (headings.length >= 2) break
    }
    return [...active.map((text) => 'active=' + text), ...headings.map((text) => 'heading=' + text)].join('|').slice(0, 360)
  }

  function send(type, payload, requestId, action) {
    if (!activePostMessage) return
    const message = { channel: BRIDGE_CHANNEL, version: VERSION, type, payload }
    if (requestId) message.requestId = requestId
    if (action) message.action = action
    activePostMessage(message)
  }

  function rectFor(element) {
    if (!(element instanceof Element)) return null
    const rect = element.getBoundingClientRect()
    if (![rect.left, rect.top, rect.width, rect.height].every(finite) || rect.width <= 0 || rect.height <= 0) return null
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  function escapeAttribute(value) {
    const slash = String.fromCharCode(92)
    return String(value).split(slash).join(slash + slash).split('"').join(slash + '"')
  }

  function escapeIdentifier(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(value)
    const slash = String.fromCharCode(92)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => slash + character.codePointAt(0).toString(16) + ' ')
  }

  function unique(selector) {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }

  function selectorFor(element) {
    const annotationId = element.getAttribute('data-annotation-id')?.trim()
    if (annotationId) {
      const selector = '[data-annotation-id="' + escapeAttribute(annotationId) + '"]'
      if (selector.length <= MAX_SELECTOR && unique(selector)) return selector
    }

    const id = element.getAttribute('id')?.trim()
    if (id) {
      const selector = '#' + escapeIdentifier(id)
      if (selector.length <= MAX_SELECTOR && unique(selector)) return selector
    }

    for (const attribute of stableAttributes) {
      const value = element.getAttribute(attribute)?.trim()
      if (!value) continue
      const selector = element.localName + '[' + attribute + '="' + escapeAttribute(value) + '"]'
      if (selector.length <= MAX_SELECTOR && unique(selector)) return selector
    }

    const parts = []
    let current = element
    while (current && current !== document.documentElement && parts.join(' > ').length <= MAX_SELECTOR) {
      const name = current.localName
      if (!name) break
      const parent = current.parentElement
      let part = name.toLowerCase()
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.localName === name)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(part)
      const selector = parts.join(' > ')
      if (unique(selector)) return selector
      current = parent
    }
    return parts.join(' > ').slice(0, MAX_SELECTOR) || element.localName.toLowerCase()
  }

  function statePayload() {
    return { href: href(), viewport: viewport(), view: viewIdentity() }
  }

  function handleHitTest(payload) {
    if (!isRecord(payload) || !finite(payload.x) || !finite(payload.y)) return null
    if (payload.x < 0 || payload.y < 0 || payload.x > innerWidth || payload.y > innerHeight) return null
    const element = document.elementFromPoint(payload.x, payload.y)
    const rect = rectFor(element)
    if (!element || !rect) return null
    const selector = selectorFor(element)
    if (!shortString(selector, MAX_SELECTOR)) return null
    return { selector, rect }
  }

  function handleResolve(payload) {
    if (!isRecord(payload) || !Array.isArray(payload.items) || payload.items.length > MAX_ITEMS) return []
    const results = []
    for (const item of payload.items) {
      if (!isRecord(item) || !shortString(item.id, MAX_ITEM_ID) || !shortString(item.selector, MAX_SELECTOR)) continue
      let element = null
      try { element = document.querySelector(item.selector) } catch {}
      results.push({ id: item.id, rect: rectFor(element) })
    }
    return results
  }

  function handleHostMessage(candidate, postMessage, event) {
    if (activePort && activePort !== candidate) return
    if (!isRecord(event.data)) return
    const data = event.data
    if (data.channel !== HOST_CHANNEL || data.version !== VERSION || Object.keys(data).length > 6) return
    if (!shortString(data.requestId, MAX_REQUEST_ID) || !['hello', 'hit-test', 'resolve'].includes(data.action)) return

    if (!activePort) {
      activePort = candidate
      activePostMessage = postMessage
      clearTimeout(connectTimer)
      for (const offered of offeredPorts) {
        if (offered !== candidate) offered.close()
      }
      offeredPorts.clear()
    }

    let payload
    if (data.action === 'hello') payload = statePayload()
    else if (data.action === 'hit-test') payload = { ...statePayload(), hit: handleHitTest(data.payload) }
    else payload = { ...statePayload(), items: handleResolve(data.payload) }
    send('response', payload, data.requestId, data.action)
  }

  function offerConnection() {
    if (activePort) return
    const channel = new MessageChannel()
    const candidate = channel.port1
    const postMessage = candidate.postMessage.bind(candidate)
    offeredPorts.add(candidate)
    candidate.addEventListener('message', (event) => handleHostMessage(candidate, postMessage, event))
    candidate.start()
    window.parent.postMessage({ channel: CONNECT_CHANNEL, version: VERSION, type: 'connect' }, targetOrigin, [channel.port2])
    setTimeout(() => {
      if (candidate !== activePort) {
        offeredPorts.delete(candidate)
        candidate.close()
      }
    }, 1600)
    connectTimer = setTimeout(offerConnection, 180)
  }
  offerConnection()

  let changeTimer = 0
  let pendingReason = 'layout'
  function scheduleChange(reason) {
    pendingReason = reason === 'route' ? 'route' : pendingReason === 'route' ? pendingReason : reason
    if (changeTimer) return
    changeTimer = setTimeout(() => {
      changeTimer = 0
      send('change', { ...statePayload(), reason: pendingReason })
      pendingReason = 'layout'
    }, 50)
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    if (typeof original !== 'function') continue
    try {
      history[method] = function (...args) {
        const result = original.apply(this, args)
        scheduleChange('route')
        return result
      }
    } catch {}
  }
  addEventListener('hashchange', () => scheduleChange('route'))
  addEventListener('popstate', () => scheduleChange('route'))
  addEventListener('resize', () => scheduleChange('resize'), { passive: true })
  addEventListener('pagehide', () => send('disconnect', { href: href(), reason: 'navigation' }), { once: true })
  document.addEventListener('scroll', () => scheduleChange('scroll'), { capture: true, passive: true })

  const startObservers = () => {
    new MutationObserver(() => scheduleChange('layout')).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
    })
    if (globalThis.ResizeObserver) {
      const observer = new ResizeObserver(() => scheduleChange('resize'))
      observer.observe(document.documentElement)
      if (document.body) observer.observe(document.body)
    }
    send('ready', statePayload())
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObservers, { once: true })
  else startObservers()

  let previousHref = href()
  setInterval(() => {
    const currentHref = href()
    if (currentHref === previousHref) return
    previousHref = currentHref
    scheduleChange('route')
  }, 300)
})()`

const REVIEW_BRIDGE_MARKER = 'data-prototype-review-bridge="1"'
const REVIEW_BRIDGE_TAG = `<script ${REVIEW_BRIDGE_MARKER}>${REVIEW_BRIDGE_SCRIPT}</script>`
const RAW_TEXT_TAGS = new Set([
  'script', 'style', 'textarea', 'title', 'iframe', 'xmp', 'noembed', 'noframes', 'noscript', 'plaintext',
])

function tagEnd(source, start) {
  let quote = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '>') return index
  }
  return -1
}

function tagInfo(source, start, end) {
  let cursor = start + 1
  while (/\s/.test(source[cursor] ?? '')) cursor += 1
  if (source[cursor] === '!' && source.slice(cursor + 1, end).match(/^doctype(?:\s|$)/i)) {
    return { name: 'doctype', closing: false, nameEnd: cursor + 8 }
  }
  const closing = source[cursor] === '/'
  if (closing) cursor += 1
  while (/\s/.test(source[cursor] ?? '')) cursor += 1
  const match = source.slice(cursor, end).match(/^[A-Za-z][A-Za-z0-9:-]*/)
  if (!match) return null
  return { name: match[0].toLowerCase(), closing, nameEnd: cursor + match[0].length }
}

function attributes(source, nameEnd, end) {
  const result = []
  let cursor = nameEnd
  while (cursor < end) {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (cursor >= end || source[cursor] === '/') break
    const start = cursor
    while (cursor < end && !/[\s=/>]/.test(source[cursor])) cursor += 1
    const name = source.slice(start, cursor).toLowerCase()
    if (!name) { cursor += 1; continue }
    const nameEnd = cursor
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    let value = ''
    let attributeEnd = nameEnd
    if (source[cursor] === '=') {
      cursor += 1
      while (/\s/.test(source[cursor] ?? '')) cursor += 1
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor++] : ''
      const valueStart = cursor
      if (quote) {
        while (cursor < end && source[cursor] !== quote) cursor += 1
        value = source.slice(valueStart, cursor)
        if (source[cursor] === quote) cursor += 1
      } else {
        while (cursor < end && !/[\s>]/.test(source[cursor])) cursor += 1
        value = source.slice(valueStart, cursor)
      }
      attributeEnd = cursor
    }
    result.push({ name, value, start, end: attributeEnd })
  }
  return result
}

function walkTags(source, visit) {
  const lower = source.toLowerCase()
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor)
    if (start < 0) break
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4)
      cursor = commentEnd < 0 ? source.length : commentEnd + 3
      continue
    }
    const end = tagEnd(source, start)
    if (end < 0) break
    const info = tagInfo(source, start, end)
    if (!info) { cursor = end + 1; continue }
    visit({ ...info, start, end, source: source.slice(start, end + 1), attrs: attributes(source, info.nameEnd, end) })
    cursor = end + 1
    if (!info.closing && RAW_TEXT_TAGS.has(info.name)) {
      if (info.name === 'plaintext') {
        cursor = source.length
        continue
      }
      let closingStart = lower.indexOf(`</${info.name}`, cursor)
      while (closingStart >= 0 && /[A-Za-z0-9:-]/.test(source[closingStart + info.name.length + 2] ?? '')) {
        closingStart = lower.indexOf(`</${info.name}`, closingStart + info.name.length + 2)
      }
      if (closingStart >= 0) {
        const closingEnd = tagEnd(source, closingStart)
        cursor = closingEnd < 0 ? source.length : closingEnd + 1
      } else cursor = source.length
    }
  }
}

function credentialTag(tag, crossoriginValue) {
  if (tag.closing) return tag.source
  const values = new Map(tag.attrs.map((attribute) => [attribute.name, attribute.value]))
  const isModuleScript = tag.name === 'script' && values.get('type')?.toLowerCase() === 'module' && values.has('src')
  const isModulePreload = tag.name === 'link'
    && (values.get('rel') ?? '').toLowerCase().split(/\s+/).includes('modulepreload')
    && values.has('href')
  if (!isModuleScript && !isModulePreload) return tag.source

  const crossorigin = tag.attrs.find((attribute) => attribute.name === 'crossorigin')
  if (crossorigin) {
    const relativeStart = crossorigin.start - tag.start
    const relativeEnd = crossorigin.end - tag.start
    return `${tag.source.slice(0, relativeStart)}crossorigin="${crossoriginValue}"${tag.source.slice(relativeEnd)}`
  }
  const insertion = tag.source.endsWith('/>') ? tag.source.length - 2 : tag.source.length - 1
  return `${tag.source.slice(0, insertion)} crossorigin="${crossoriginValue}"${tag.source.slice(insertion)}`
}

export function normalizeModuleCredentials(html, crossoriginValue = 'use-credentials') {
  if (!['anonymous', 'use-credentials'].includes(crossoriginValue)) {
    throw new TypeError('Unsupported module crossorigin mode')
  }
  const source = String(html)
  const edits = []
  walkTags(source, (tag) => {
    const replacement = credentialTag(tag, crossoriginValue)
    if (replacement !== tag.source) edits.push({ start: tag.start, end: tag.end + 1, replacement })
  })
  let result = source
  for (const edit of edits.reverse()) result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`
  return result
}

export function injectReviewBridge(html, options = {}) {
  const source = normalizeModuleCredentials(html, options.moduleCrossorigin ?? 'use-credentials')
  let doctypeEnd = -1
  let firstTagName = ''
  walkTags(source, (tag) => {
    if (!firstTagName) firstTagName = tag.name
    if (!tag.closing && tag.name === 'doctype' && doctypeEnd < 0) doctypeEnd = tag.end + 1
  })
  // Only the complete bridge is trusted for idempotency. An uploaded page cannot
  // suppress injection by adding the public marker attribute to an empty script.
  // Run before every script supplied by the prototype, including malformed
  // pre-head scripts. Browsers place this script in an implicit head; keeping a
  // leading doctype in front preserves standards mode.
  const insertion = firstTagName === 'doctype' && doctypeEnd >= 0 ? doctypeEnd : 0
  if (source.slice(insertion, insertion + REVIEW_BRIDGE_TAG.length) === REVIEW_BRIDGE_TAG) return source
  return `${source.slice(0, insertion)}${REVIEW_BRIDGE_TAG}${source.slice(insertion)}`
}

export { REVIEW_BRIDGE_SCRIPT }
