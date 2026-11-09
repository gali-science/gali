export const GALI_NAME_PRONUNCIATION =
  'Your name is spelled "Gali", but you never say the word "Gali" out loud. Whenever you say your name, say it the Italian way, "galì", stressed on the last syllable. The "ga" is extremely short: a quick, light tap, much shorter than the "lì", with a short Italian a, never stretched and never "guh". Just say it. Never explain or comment on how your name is pronounced unless the user asks how to pronounce it.';

export function writeGaliName(text: string): string {
  return text.replace(/\bgal(?:ì|í|i\u0300|i\u0301)(?!\p{L})/giu, "Gali");
}
