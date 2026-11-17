/**
 * tmsync 有界缓存：LRU + TTL + 条目/字节上限 + 逐出统计。
 *
 * - TTL 从写入时间计算，get 只做 LRU touch，不延长 TTL。
 * - maxEntries/maxBytes/ttlMs 允许传函数，service 可随配置变化读取新值。
 * - 不启动定时器；过期项在 get/has/sweep 时惰性清理。
 */
export class BoundedMap {
  constructor({
    maxEntries = 64,
    maxBytes = Infinity,
    ttlMs = Infinity,
    sizeOf = () => 0,
    now = () => Date.now(),
    onEvict = () => {},
  } = {}) {
    this.store = new Map()
    this.options = { maxEntries, maxBytes, ttlMs, sizeOf, now, onEvict }
    this.counters = { hits: 0, misses: 0, evictions: 0, expired: 0, reasons: {} }
  }

  resolve(value, fallback = Infinity) {
    const raw = typeof value === 'function' ? value() : value
    const number = Number(raw)
    return Number.isFinite(number) ? number : fallback
  }

  get limitEntries() {
    return Math.max(1, Math.trunc(this.resolve(this.options.maxEntries, 64)))
  }

  get limitBytes() {
    const value = this.resolve(this.options.maxBytes, Infinity)
    return value === Infinity ? Infinity : Math.max(1, Math.trunc(value))
  }

  ttlMs() {
    const value = this.resolve(this.options.ttlMs, Infinity)
    return value === Infinity ? Infinity : Math.max(0, Math.trunc(value))
  }

  now() {
    return Number(this.options.now()) || 0
  }

  bytesOf(value, key) {
    try {
      const bytes = Number(this.options.sizeOf(value, key))
      return Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0
    } catch {
      return 0
    }
  }

  evict(key, entry, reason) {
    if (!this.store.has(key)) return
    this.store.delete(key)
    this.counters.evictions += 1
    this.counters.reasons[reason] = (this.counters.reasons[reason] || 0) + 1
    if (reason === 'ttl') this.counters.expired += 1
    try { this.options.onEvict(entry.value, key, reason) } catch { /* ignore */ }
  }

  expired(entry) {
    return entry.expiresAt !== Infinity && entry.expiresAt <= this.now()
  }

  get(key) {
    const entry = this.store.get(key)
    if (entry === undefined) {
      this.counters.misses += 1
      return undefined
    }
    if (this.expired(entry)) {
      this.evict(key, entry, 'ttl')
      this.counters.misses += 1
      return undefined
    }
    this.store.delete(key)
    this.store.set(key, entry)
    this.counters.hits += 1
    return entry.value
  }

  has(key) {
    const entry = this.store.get(key)
    if (entry === undefined) return false
    if (this.expired(entry)) {
      this.evict(key, entry, 'ttl')
      return false
    }
    return true
  }

  set(key, value) {
    const previous = this.store.get(key)
    if (previous !== undefined) this.evict(key, previous, 'replace')
    const ttl = this.ttlMs()
    const entry = {
      value,
      bytes: this.bytesOf(value, key),
      expiresAt: ttl === Infinity ? Infinity : this.now() + ttl,
    }
    this.store.set(key, entry)
    this.trim({ protect: key })
    return this
  }

  delete(key) {
    const entry = this.store.get(key)
    if (entry !== undefined) this.evict(key, entry, 'delete')
    return entry !== undefined
  }

  clear(reason = 'clear') {
    for (const [key, entry] of [...this.store]) this.evict(key, entry, reason)
  }

  dispose() {
    this.clear('dispose')
  }

  sweep() {
    let count = 0
    for (const [key, entry] of [...this.store]) {
      if (!this.expired(entry)) continue
      this.evict(key, entry, 'ttl')
      count += 1
    }
    return count
  }

  trim({ protect } = {}) {
    let bytes = 0
    for (const entry of this.store.values()) bytes += entry.bytes
    for (const [key, entry] of this.store) {
      if (key === protect) continue
      if (this.store.size <= this.limitEntries && bytes <= this.limitBytes) break
      if (this.store.size <= 1) break
      bytes -= entry.bytes
      this.evict(key, entry, 'trim')
    }
  }

  entries() {
    this.sweep()
    return [...this.store.entries()].map(([key, entry]) => [key, entry.value])
  }

  keys() {
    return this.entries().map(([key]) => key)
  }

  values() {
    return this.entries().map(([, value]) => value)
  }

  get size() {
    return this.store.size
  }

  get bytes() {
    let total = 0
    for (const entry of this.store.values()) total += entry.bytes
    return total
  }

  stats() {
    return {
      size: this.size,
      bytes: this.bytes,
      maxEntries: this.limitEntries,
      maxBytes: this.limitBytes,
      hits: this.counters.hits,
      misses: this.counters.misses,
      evictions: this.counters.evictions,
      expired: this.counters.expired,
      reasons: { ...this.counters.reasons },
    }
  }
}

export function approxJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return 0
  }
}
