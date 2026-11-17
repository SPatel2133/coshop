import { RoomError } from "./config.js";

const pageSize = 30;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isDiscussion = (type) =>
  [
    "chat_post",
    "comment_post",
    "rate_find",
    "discussion_history",
    "discussion_summary",
  ].includes(type);
const invalid = (message) => new RoomError("INVALID_DISCUSSION", message);

export function discussionFor(message, person) {
  if (
    message.type !== "discussion" ||
    message.actor === person ||
    !message.summary
  )
    return message;
  const { yourRating, ...summary } = message.summary;
  return { ...message, summary };
}

export class Discussion {
  constructor(store) {
    this.store = store;
  }
  find(room, id) {
    if (
      typeof id !== "string" ||
      !uuid.test(id) ||
      !this.store.all(
        "SELECT 1 FROM shared_finds WHERE room_id=? AND first_event_id=?",
        room,
        id,
      ).length
    )
      throw new RoomError(
        "FIND_NOT_FOUND",
        "This find is no longer available.",
        404,
      );
    return id;
  }
  summaries(room, user, version, findId = null) {
    const scope = findId ? " AND find_id=?" : "";
    const args = findId ? [room, findId] : [room];
    const summaries = new Map();
    const get = (id) => {
      if (!summaries.has(id))
        summaries.set(id, {
          findId: id,
          version,
          commentCount: 0,
          ratingCount: 0,
          average: null,
          yourRating: null,
        });
      return summaries.get(id);
    };
    if (findId) get(findId);
    for (const row of this.store.all(
      `SELECT find_id,COUNT(*) AS count
      FROM discussion_entries WHERE room_id=? AND find_id IS NOT NULL AND text IS NOT NULL${scope} GROUP BY find_id`,
      ...args,
    ))
      get(row.find_id).commentCount = row.count;
    for (const row of this.store.all(
      `SELECT find_id,COUNT(*) AS count,AVG(score) AS average,
      MAX(CASE WHEN user_id=? THEN score END) AS personal
      FROM find_ratings WHERE room_id=?${scope} GROUP BY find_id`,
      user,
      ...args,
    ))
      Object.assign(get(row.find_id), {
        ratingCount: row.count,
        average: row.average,
        yourRating: row.personal,
      });
    return [...summaries.values()];
  }
  entry(row) {
    return {
      id: row.id,
      sequence: row.sequence,
      findId: row.find_id,
      text: row.text,
      author: row.display_name,
      createdAt: row.created_at,
    };
  }
  history(room, message) {
    const findId =
      message.findId == null ? null : this.find(room, message.findId);
    const before = message.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1)
      throw invalid("Invalid message history cursor.");
    const rows = this.store.all(
      `SELECT entry.*,person.display_name FROM discussion_entries entry
      JOIN participants person ON person.id=entry.user_id
      WHERE entry.room_id=? AND entry.find_id IS ? AND entry.text IS NOT NULL AND entry.sequence<?
      ORDER BY entry.sequence DESC LIMIT ?`,
      room,
      findId,
      before,
      pageSize + 1,
    );
    return {
      findId,
      entries: rows
        .slice(0, pageSize)
        .reverse()
        .map((row) => this.entry(row)),
      hasEarlier: rows.length > pageSize,
    };
  }
  write(room, user, message, now) {
    const { type, requestId } = message;
    const findId =
      type === "chat_post" ? null : this.find(room, message.findId);
    const score = type === "rate_find" ? message.score : null;
    const text =
      type === "rate_find"
        ? null
        : typeof message.text === "string"
          ? message.text.trim()
          : "";
    if (
      type === "rate_find" &&
      (!Number.isInteger(score) || score < 1 || score > 5)
    )
      throw invalid("Choose a whole number from 1 to 5.");
    if (
      type !== "rate_find" &&
      (!text ||
        text.length > 400 ||
        !text.isWellFormed() ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(text))
    )
      throw invalid("Write a message between 1 and 400 characters.");
    const existing = this.store.all(
      `SELECT entry.*,person.display_name FROM discussion_entries entry
      JOIN participants person ON person.id=entry.user_id WHERE entry.id=?`,
      requestId,
    )[0];
    if (existing) {
      if (
        existing.room_id !== room ||
        existing.user_id !== user ||
        existing.find_id !== findId ||
        existing.text !== text ||
        existing.score !== score
      )
        throw invalid("That request was already used for a different action.");
      return {
        findId,
        entry: text === null ? null : this.entry(existing),
        replay: true,
      };
    }
    const last = this.store.all(
      `SELECT created_at FROM discussion_entries WHERE room_id=? AND user_id=?
      AND (text IS NULL)=? ORDER BY sequence DESC LIMIT 1`,
      room,
      user,
      text === null ? 1 : 0,
    )[0];
    const retryAfterMs =
      (last?.created_at ?? -Infinity) + (text === null ? 350 : 800) - now;
    if (retryAfterMs > 0)
      throw Object.assign(
        new RoomError("COOLDOWN", "Give it a moment, then try again.", 429),
        { retryAfterMs },
      );
    const row = this.store.all(
      `INSERT INTO discussion_entries(id,room_id,user_id,find_id,text,score,created_at)
      VALUES(?,?,?,?,?,?,?) RETURNING *`,
      requestId,
      room,
      user,
      findId,
      text,
      score,
      now,
    )[0];
    if (text === null)
      this.store.run(
        `INSERT INTO find_ratings(room_id,find_id,user_id,score) VALUES(?,?,?,?)
      ON CONFLICT(room_id,find_id,user_id) DO UPDATE SET score=excluded.score`,
        room,
        findId,
        user,
        score,
      );
    else
      row.display_name = this.store.all(
        "SELECT display_name FROM participants WHERE id=?",
        user,
      )[0].display_name;
    return {
      findId,
      entry: text === null ? null : this.entry(row),
      replay: false,
    };
  }
  command(room, user, message, now, version, touch) {
    const { requestId, type } = message;
    if (typeof requestId !== "string" || !uuid.test(requestId))
      throw invalid("Invalid discussion request.");
    const ack = { type: "command_ack", requestId, ok: true };
    if (type === "discussion_history")
      return { ack: { ...ack, page: this.history(room, message) } };
    if (type === "discussion_summary")
      return {
        ack: { ...ack, summaries: this.summaries(room, user, version) },
      };
    const { findId, entry, replay } = this.write(room, user, message, now);
    if (!replay) touch();
    const summary = findId
      ? this.summaries(room, user, version + Number(!replay), findId)[0]
      : null;
    return {
      ack: { ...ack, entry, summary },
      notification: replay
        ? null
        : { type: "discussion", actor: user, entry, summary },
    };
  }
}
