import { describe, expect, it } from "vitest";
import { SkipElector } from "../src/skip.js";

describe("SkipElector", () => {
  it("skips immediately when the voter is the only listener", () => {
    const elector = new SkipElector();
    const result = elector.vote("g1", "u1", ["u1"]);
    expect(result.status).toBe("passed-by-this-vote");
    expect(result.required).toBe(1);
  });

  it("needs a majority of the current listeners", () => {
    const elector = new SkipElector();
    const listeners = ["u1", "u2", "u3", "u4", "u5"];
    const first = elector.vote("g1", "u1", listeners);
    expect(first.status).toBe("counted");
    expect(first.required).toBe(3);
    expect(first.remaining).toBe(2);

    const second = elector.vote("g1", "u2", listeners);
    expect(second.status).toBe("counted");

    const third = elector.vote("g1", "u3", listeners);
    expect(third.status).toBe("passed-by-this-vote");
  });

  it("rejects duplicate votes", () => {
    const elector = new SkipElector();
    elector.vote("g1", "u1", ["u1", "u2"]);
    const again = elector.vote("g1", "u1", ["u1", "u2"]);
    expect(again.status).toBe("already");
    expect(again.voters).toEqual(["u1"]);
  });

  it("keeps separate tallies per guild", () => {
    const elector = new SkipElector();
    elector.vote("g1", "u1", ["u1", "u2"]);
    const g2 = elector.vote("g2", "u1", ["u1", "u2"]);
    expect(g2.status).toBe("counted");
  });

  it("passes at exactly half when the quorum rounds up", () => {
    const elector = new SkipElector();
    const listeners = ["u1", "u2", "u3", "u4"]; // majority of 4 = 3
    elector.vote("g1", "u1", listeners);
    elector.vote("g1", "u2", listeners);
    const third = elector.vote("g1", "u3", listeners);
    expect(third.status).toBe("passed-by-this-vote");
  });

  it("recomputes the threshold when listeners leave", () => {
    const elector = new SkipElector();
    elector.vote("g1", "u1", ["u1", "u2", "u3", "u4"]);
    elector.vote("g1", "u2", ["u1", "u2", "u3", "u4"]);
    // u3 and u4 walk out — only u1 and u2 remain, and both have voted, so
    // u1's duplicate vote (or any vote) passes the election on the spot.
    const result = elector.vote("g1", "u1", ["u1", "u2"]);
    expect(result.required).toBe(2);
    expect(result.voters).toEqual(["u1", "u2"]);
    expect(result.status).toBe("passed-by-this-vote");
  });

  it("prunes votes from members who left, then passes with live voters", () => {
    const elector = new SkipElector();
    const six = ["u1", "u2", "u3", "u4", "u5", "u6"];
    elector.vote("g1", "u1", six);
    elector.vote("g1", "u2", six);
    const third = elector.vote("g1", "u3", six); // 3/4 of six — not passed yet
    expect(third.status).toBe("counted");

    // u2 and u3 leave the channel. Until the next vote the raw tally keeps
    // them; the next vote prunes them and counts only live listeners.
    expect(elector.state("g1", ["u1", "u4", "u5", "u6"]).voters).toEqual(["u1", "u2", "u3"]);

    const fresh = elector.vote("g1", "u4", ["u1", "u4", "u5", "u6"]);
    expect(fresh.voters).toEqual(["u1", "u4"]);
    expect(fresh.required).toBe(3);
    expect(fresh.status).toBe("counted");

    const fifth = elector.vote("g1", "u5", ["u1", "u4", "u5", "u6"]);
    expect(fifth.status).toBe("passed-by-this-vote");
  });

  it("resets between tracks", () => {
    const elector = new SkipElector();
    elector.vote("g1", "u1", ["u1", "u2"]);
    elector.reset("g1");
    expect(elector.state("g1", ["u1", "u2"]).voters).toEqual([]);
  });
});