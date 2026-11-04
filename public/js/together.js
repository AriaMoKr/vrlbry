// The shared session (SPEC §5.6 "Together"): the Hallway's (AriaMoKr/layersharedsession, peer to
// peer over WebRTC with Trystero, through public Nostr relays; common's README, "Going in"). Its
// room is in the address (?room=), so the address is the invitation: the Hallway's door brings it
// here, and the way back carries it on (main.js, common's leaveUrl), so the visitor stays in it.
// This page is its door's id in the session (together-space.js PAGE_ID).
//
// The layer's controller (together.js, createTogether) runs it: joining and leaving, stepping out
// for the door and back, the room in the address, this visitor's pose and the others' avatars
// (a head with a visor on its front, a hand per tracked controller, a ring on the floor and their
// name), loading the session module and Trystero only when a session is joined. What is the
// library's own stays here: where in the library each visitor is (together-space.js: each place
// and room is laid out on its own), so only those in the same room are drawn and counted here,
// and the words (noticeText). The vendor modules are named by relative URL (server/vendor.js
// rewrites their bare imports, and the Pages build copies them).

import { createTogether } from '../vendor/layersharedsession/together.js';
import { APP_ID, noticeText, PAGE_ID, spaceKey } from './together-space.js';

const SPACE_PREFIX = spaceKey('');

export class Together {
  /**
   * @param {object} o
   * @param {import('three').Scene} o.scene
   * @param {import('three').Camera} o.camera the viewer's head
   * @param {import('three').WebGLRenderer} o.renderer
   * @param {() => Array<{ controller: import('three').Object3D, source: XRInputSource|null }>} o.hands the controllers (controls.js)
   * @param {Function|null} [o.joinSession] a stand-in for the layer's session module: for tests
   */
  constructor({ scene, camera, renderer, hands, joinSession = null }) {
    this.space = null; // where in the library this visitor is (together-space.js spaceOf)
    this.onChange = () => {};
    this.onNotice = () => {}; // (text)
    // Whether a visitor on this page is here: in the same room of the library. Each avatar keeps
    // the key of its visitor's space, made again when the member id changes, so the frames that
    // place the avatars allocate nothing.
    const isHere = (peer, a) => {
      const s = this.layer.session;
      if (!s || !a || !peer.memberId) return false;
      if (a.memberId !== peer.memberId) {
        a.memberId = peer.memberId;
        a.spaceKey = spaceKey(peer.memberId);
      }
      return s.get(a.spaceKey) === this.space;
    };
    this.layer = createTogether({ appId: APP_ID, page: PAGE_ID, camera, renderer, hands, avatars: { parent: scene }, isHere, joinSession });
    this.layer.on('change', () => this.onChange());
    this.layer.on('notice', (n) => {
      const text = noticeText(n);
      if (text) this.onNotice(text);
    });
    this.layer.on('session', (s) => {
      // Where this visitor is, told to the others, and again when the member id is replaced
      // (another tab had it); a visitor moving between rooms redraws.
      s.set(spaceKey(s.self.memberId), this.space);
      s.on('self', (self) => s.set(spaceKey(self.memberId), this.space));
      s.on('shared', ({ key }) => { if (key.startsWith(SPACE_PREFIX)) this.onChange(); });
    });
  }

  /** In a session (joined, or joining). */
  get active() {
    return this.layer.active;
  }

  /** The room joined, or kept while paused (going out by the door); null out of a session. */
  get room() {
    return this.layer.room;
  }

  /** The address that brings others into the session (shown as text on a TV); '' out of one. */
  get inviteLink() {
    return this.layer.inviteLink;
  }

  /** Less motion: a visitor's wave is only its notice, without the bob. */
  set reduceMotion(on) {
    this.layer.reduceMotion = on;
  }

  /**
   * Who else is in the session: in this room (here), elsewhere in the library (nearby), on
   * another page (away), and connected but not yet said hello (connecting).
   */
  company() {
    return this.layer.company();
  }

  /** Joins `room` (an invitation's, the Hallway door's) and keeps it in the address. */
  start(room) {
    this.layer.start(room);
  }

  /** Leaves the session and takes the room out of the address. */
  stop() {
    return this.layer.stop();
  }

  /** Leaves for now, keeping the room: going out by the door (its link carries the room on). */
  pause() {
    return this.layer.pause();
  }

  /** Back after a pause (the navigation didn't happen, or Back restored this page). */
  resume() {
    this.layer.resume();
  }

  /** Where in the library this visitor now is (together-space.js spaceOf), told to the others. */
  setSpace(space) {
    if (space === this.space) return;
    this.space = space;
    const s = this.layer.session;
    if (s && s.self.memberId) s.set(spaceKey(s.self.memberId), space);
    this.onChange();
  }

  /**
   * Per frame: sends where the head and hands are (at most 15 times a second), and places the
   * others who are in this room of the library. Allocates nothing (GC pauses on a Quest).
   */
  update(now) {
    this.layer.update(now);
  }
}
