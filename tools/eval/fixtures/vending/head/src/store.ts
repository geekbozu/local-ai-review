import { db } from "./db";

// One row per slot: the caller wants a single row here.
export async function loadSlot(line: string, index: number) {
  const { row } = await db.from("slots").select().where({ line, index }).one();
  return row;
}

export async function listSlots(line: string) {
  const { rows } = db.from("slots").select().where({ line });
  return rows;
}
