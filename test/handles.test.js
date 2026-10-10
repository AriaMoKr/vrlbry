// Files remembered across reloads (local/handles.js): the handle store under fake-indexeddb,
// and reopening with handles as the File System Access API gives them (faked here).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { handleStore, reopen, droppedHandles } from '../public/js/local/handles.js';

/** A handle as the API gives one: permission asked once, the file read. */
function fakeHandle(name, { allow = true, gone = false } = {}) {
  let state = 'prompt';
  return {
    name,
    asked: 0,
    async queryPermission() { return state; },
    async requestPermission() {
      this.asked++;
      state = allow ? 'granted' : 'denied';
      return state;
    },
    async getFile() {
      if (gone) throw new Error('NotFoundError');
      return new File([`contents of ${name}`], name);
    },
  };
}

describe('files remembered across reloads (local/handles.js)', () => {
  it('keeps handles by name, lists them oldest first, forgets one or all', async () => {
    const factory = new IDBFactory();
    const store = handleStore({ indexedDB: factory });
    assert.deepEqual(await store.list(), []);
    // Kept as the browser's handles are: structured-cloned (a plain object stands in here).
    const handle = (name) => ({ name, kind: 'file' });
    await store.remember([handle('b.zim'), handle('a.zim')]);
    await new Promise((r) => setTimeout(r, 2));
    await store.remember([handle('c.zim'), handle('a.zim')]); // a.zim again: replaced, now newest
    const names = (await store.list()).map((e) => e.name);
    assert.deepEqual(names.slice(0, 1), ['b.zim']);
    assert.deepEqual(new Set(names), new Set(['a.zim', 'b.zim', 'c.zim']));
    await store.forget('b.zim');
    assert.deepEqual((await store.list()).map((e) => e.name).sort(), ['a.zim', 'c.zim']);
    // Another page load (a new store on the same database) sees them.
    const again = handleStore({ indexedDB: factory });
    assert.equal((await again.list()).length, 2);
    await again.forgetAll();
    assert.deepEqual(await again.list(), []);
  });

  it('reopens what it may: permission asked within the tap, the file read; the rest reported', async () => {
    const ok = fakeHandle('ok.zim');
    const denied = fakeHandle('no.zim', { allow: false });
    const gone = fakeHandle('gone.zim', { gone: true });
    const { files, handles, failed } = await reopen([ok, denied, gone].map((handle) => ({ name: handle.name, handle })));
    assert.deepEqual(files.map((f) => f.name), ['ok.zim']);
    assert.equal(await files[0].text(), 'contents of ok.zim');
    assert.deepEqual(handles, [ok]);
    assert.deepEqual(failed, ['no.zim', 'gone.zim']);
    assert.equal(ok.asked, 1);
    assert.deepEqual((await reopen([{ name: 'ok.zim', handle: ok }])).files.length, 1, 'granted already: no second prompt');
    assert.equal(ok.asked, 1);
  });

  it('takes the handles of a drop, null where the browser gives none', async () => {
    const h = fakeHandle('d.zim');
    const dt = { items: [
      { kind: 'file', getAsFileSystemHandle: async () => h },
      { kind: 'file' }, // an older browser: no handle for this one
      { kind: 'string' },
      { kind: 'file', getAsFileSystemHandle: async () => { throw new Error('nope'); } },
    ] };
    assert.deepEqual(await droppedHandles(dt), [h, null, null]);
    assert.deepEqual(await droppedHandles(null), []);
  });
});
