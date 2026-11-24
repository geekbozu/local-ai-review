import { db } from "./db";

export async function listSlots(line: string) {
  return db.from("slots").select().where({ line });
}

export async function loadSlot(line: string, index: number) {
  const { row } = await db.from("slots").select().where({ line, index }).maybeOne();
  return row ?? null;
}
