import { describe, expect, it } from "vitest";
import { MusicQueue } from "../src/queue.js";
import type { Track } from "../src/types.js";

let seq = 0;
export function track(overrides: Partial<Track> = {}): Track {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Song ${seq}`,
    author: "Artist",
    videoId: `vid${seq}`,
    sourceKind: "youtube",
    url: `https://www.youtube.com/watch?v=vid${seq}`,
    durationMs: 180_000,
    requestedBy: "user-1",
    requestedByName: "User One",
    thumbnail: null,
    ...overrides,
  };
}

describe("MusicQueue", () => {
  it("plays the first added track, then advances in order", () => {
    const q = new MusicQueue();
    expect(q.next()).toBeNull();

    const a = track();
    const b = track();
    q.add(a);
    q.add(b);

    expect(q.next()).toBe(a); // first play consumes the head
    expect(q.nowPlaying()).toBe(a);
    expect(q.size).toBe(1);

    expect(q.next()).toBe(b);
    expect(q.nowPlaying()).toBe(b);
    expect(q.next()).toBeNull();
  });

  it("loops a single track", () => {
    const q = new MusicQueue();
    const a = track();
    q.add(a);
    q.setLoop("track");
    expect(q.next()).toBe(a);
    expect(q.next()).toBe(a);
    expect(q.next()).toBe(a);
    expect(q.nowPlaying()).toBe(a);
    expect(q.size).toBe(0);
  });

  it("loops the whole queue by recycling the finished track", () => {
    const q = new MusicQueue();
    const a = track();
    const b = track();
    q.add(a);
    q.add(b);
    q.setLoop("queue");

    expect(q.next()).toBe(a);
    expect(q.next()).toBe(b); // a goes to the back
    expect(q.upcoming()).toEqual([a]);
    expect(q.next()).toBe(a); // b goes to the back
    expect(q.upcoming()).toEqual([b]);
  });

  it("removes by 1-based position and rejects out-of-range ones", () => {
    const q = new MusicQueue();
    const a = track();
    const b = track();
    q.add(a);
    q.add(b);
    expect(q.remove(1)).toBe(a);
    expect(q.remove(0)).toBeNull();
    expect(q.remove(5)).toBeNull();
    expect(q.remove(1.5)).toBeNull();
    expect(q.upcoming()).toEqual([b]);
  });

  it("clears only the upcoming tracks", () => {
    const q = new MusicQueue();
    const a = track();
    q.add(a);
    q.add(track());
    expect(q.next()).toBe(a);
    expect(q.clear()).toBe(1);
    expect(q.isEmpty).toBe(false);
    expect(q.next()).toBeNull();
    expect(q.isEmpty).toBe(true);
  });

  it("shuffles without touching the current track", () => {
    const q = new MusicQueue();
    for (let i = 0; i < 30; i += 1) q.add(track());
    const current = q.next();
    const before = q.size;
    expect(q.shuffle()).toBe(before);
    expect(q.nowPlaying()).toBe(current);
    // 30 distinct tracks must all still be there after shuffling.
    const ids = new Set(q.upcoming().map((t) => t.id));
    expect(ids.size).toBe(before);
  });

  it("cycles loop modes", () => {
    const q = new MusicQueue();
    expect(q.loopMode).toBe("off");
    expect(q.cycleLoop()).toBe("track");
    expect(q.cycleLoop()).toBe("queue");
    expect(q.cycleLoop()).toBe("off");
  });

  it("respects the cap when bulk-adding", () => {
    const q = new MusicQueue();
    expect(q.addMany([track(), track(), track()], 2)).toBe(2);
    expect(q.size).toBe(2);
  });

  it("sums upcoming duration only when every track has one", () => {
    const q = new MusicQueue();
    q.add(track({ durationMs: 60_000 }));
    q.add(track({ durationMs: 30_000 }));
    expect(q.snapshot().upcomingDurationMs).toBe(90_000);
    q.add(track({ durationMs: null }));
    expect(q.snapshot().upcomingDurationMs).toBeNull();
  });
});