import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadScores(supabase: SupabaseClient, auditionId: string) {
  const { data } = await supabase.from("Scores").select("*").eq("audition_id", auditionId).maybeSingle();
  return data ?? null;
}

export async function listScores(supabase: SupabaseClient, eventId: string) {
  return supabase.from("Scores").select("*").eq("event_id", eventId);
}
