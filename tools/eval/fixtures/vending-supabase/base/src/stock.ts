import type { SupabaseClient } from "@supabase/supabase-js";

export async function listStock(supabase: SupabaseClient, lineId: string) {
  return supabase.from("Stock").select("*").eq("line_id", lineId);
}

export async function loadStock(supabase: SupabaseClient, lineId: string) {
  const { data } = await supabase.from("Stock").select("*").eq("line_id", lineId).maybeSingle();
  return data ?? null;
}
