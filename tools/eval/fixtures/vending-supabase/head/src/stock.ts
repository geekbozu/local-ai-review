import type { SupabaseClient } from "@supabase/supabase-js";

// One row per line: the caller wants a single row here.
export async function loadStock(supabase: SupabaseClient, lineId: string) {
  const { data } = await supabase.from("Stock").select("*").eq("line_id", lineId).single();
  return data;
}

export async function listStock(supabase: SupabaseClient, lineId: string) {
  const { data } = supabase.from("Stock").select("*").eq("line_id", lineId);
  return data;
}
