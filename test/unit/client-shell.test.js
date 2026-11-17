import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../lib/client.js'), 'utf8')

function loadShell() {
  let definition
  const window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    location: { origin: 'http://127.0.0.1:3080', search: '' },
  }
  vm.runInNewContext(source, { window, console, setTimeout, clearTimeout, EventSource: class {}, fetch: () => Promise.reject(new Error('no')) })
  assert.ok(definition)
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (value) => ({ current: value ?? null }),
    useEffect: () => {},
    useState: (value) => [value, () => {}],
  }
  return definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  })
}

function fakeCtx({ withLocale }) {
  const registrations = []
  const locale = withLocale
    ? { register: () => () => {}, bind: () => (key) => key }
    : undefined
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('locale') && locale) {
        callback({ locale, effect: (fn) => fn() })
      }
    },
    effect: (fn) => {
      const dispose = fn()
      return dispose
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options) => {
        registrations.push(options)
        return () => {}
      },
    },
  }
  return { ctx, registrations }
}

test('client shell: top-level inject is only slots', () => {
  const shell = loadShell()
  assert.equal(Array.from(shell.inject).join(','), 'slots')
})

test('client shell: no locale omits locale option; locale present includes it', () => {
  const without = fakeCtx({ withLocale: false })
  loadShell().apply(without.ctx)
  const mainWithout = without.registrations.find((item) => item.name === 'main')
  const sidebarWithout = without.registrations.find((item) => item.name === 'sidebar.panellist')
  const cardWithout = without.registrations.find((item) => item.name === 'plugins.bundle.config')
  assert.ok(mainWithout)
  assert.ok(sidebarWithout)
  assert.ok(cardWithout)
  assert.equal(mainWithout.locale, undefined)
  assert.equal(sidebarWithout.locale, undefined)
  assert.equal(cardWithout.locale, undefined)
  assert.equal(cardWithout.key, 'tmsync')

  const withLocale = fakeCtx({ withLocale: true })
  loadShell().apply(withLocale.ctx)
  const main = withLocale.registrations.find((item) => item.name === 'main')
  const sidebar = withLocale.registrations.find((item) => item.name === 'sidebar.panellist')
  const card = withLocale.registrations.find((item) => item.name === 'plugins.bundle.config')
  assert.ok(main)
  assert.ok(sidebar)
  assert.ok(card)
  assert.equal(main.locale, 'tmsync')
  assert.equal(sidebar.locale, 'tmsync')
  assert.equal(card.locale, 'tmsync')
  assert.equal(card.key, 'tmsync')
})
