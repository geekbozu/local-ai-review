import type { SupabaseClient } from "@supabase/supabase-js";

// The same query shape as before, but this one throws on a duplicate row instead of returning null.
export async function loadScores(supabase: SupabaseClient, auditionId: string) {
  const { data } = await supabase.from("Scores").select("*").eq("audition_id", auditionId).single();
  return data;
}

export async function listScores(supabase: SupabaseClient, eventId: string) {
  const { data } = supabase.from("Scores").select("*").eq("event_id", eventId);
  return data;
}
