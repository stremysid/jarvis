import { isAuthenticatedFirstPersonQuote } from "./policy.ts";

type Case = { name: string; source: string; quote: string };
const Q = "I am moving to Calgary in June.";
const cases: Case[] = [
  // Controls: should be rejected (round-1 case and builder's named cases)
  { name: "control: Mum texted me. <quote>", source: `Mum texted me. ${Q}`, quote: Q },
  { name: "control: plain owner sentence", source: Q, quote: Q },
  // Colon / dash in same sentence
  { name: "colon label: Mum: <quote>", source: `Mum: ${Q}`, quote: Q },
  { name: "dash: Mum - <quote>", source: `Mum - ${Q}`, quote: Q },
  { name: "em dash: Mum — <quote>", source: `Mum — ${Q}`, quote: Q },
  { name: "from Mum: newline <quote>", source: `From Mum:\n${Q}`, quote: Q },
  { name: "my friend's message: <quote>", source: `My friend's message: ${Q}`, quote: Q },
  // Quote marks
  { name: "quoted forward \"<quote>\"", source: `Mum's text "${Q}"`, quote: Q },
  { name: "curly quoted", source: `“${Q}”`, quote: Q },
  // Attribution verbs NOT in the list, sentence-terminated before the quote
  { name: "Mum sent this. <quote>", source: `Mum sent this. ${Q}`, quote: Q },
  { name: "Got a text from Mum. <quote>", source: `Got a text from Mum. ${Q}`, quote: Q },
  { name: "Forwarding Mum's message. <quote>", source: `Forwarding Mum's message. ${Q}`, quote: Q },
  { name: "Mum called. <quote>", source: `Mum called. ${Q}`, quote: Q },
  { name: "Mum replied. <quote>", source: `Mum replied. ${Q}`, quote: Q },
  { name: "Mum writes. <quote>", source: `Mum writes. ${Q}`, quote: Q },
  { name: "Mum tells me. <quote>", source: `Mum tells me. ${Q}`, quote: Q },
  { name: "Mum texts. <quote>", source: `Mum texts. ${Q}`, quote: Q },
  { name: "Mum posted on Facebook. <quote>", source: `Mum posted on Facebook. ${Q}`, quote: Q },
  { name: "Mum DM'd me. <quote>", source: `Mum DM'd me. ${Q}`, quote: Q },
  { name: "Mum asked me to share. <quote>", source: `Mum asked me to share this. ${Q}`, quote: Q },
  { name: "From Mum. <quote>", source: `From Mum. ${Q}`, quote: Q },
  { name: "Mum's WhatsApp. <quote>", source: `Mum's WhatsApp. ${Q}`, quote: Q },
  { name: "Copying what Dad sent me. <diagnosis>", source: "Copying what Dad sent me. I have been diagnosed with diabetes.", quote: "I have been diagnosed with diabetes." },
  { name: "Here's Priya's email. <quote>", source: `Here's Priya's email. ${Q}`, quote: Q },
  { name: "Mum's voicemail! <quote>", source: `Mum's voicemail! ${Q}`, quote: Q },
  { name: "chat log label newline", source: `Mum 9:41 PM\nHi sweetie.\n${Q}`, quote: Q },
  { name: "pasted chat 'Mum: Hi sweetie. <quote>'", source: `Mum: Hi sweetie. ${Q}`, quote: Q },
  { name: "Dad forwarded this. <quote>", source: `Dad forwarded this. ${Q}`, quote: Q },
  { name: "According to Mum. <quote>", source: `According to Mum. ${Q}`, quote: Q },
  { name: "multi-line paste, attribution only as header w/o verb", source: `Mum\n\nHi love.\n${Q}\nLove you xx`, quote: Q },
  // Attribution AFTER the sentence (builder chose to allow)
  { name: "<quote> That's what Mum said.", source: `${Q} That's what Mum said.`, quote: Q },
  { name: "<quote> Mum just texted that.", source: `${Q} Mum just texted that.`, quote: Q },
  { name: "<quote> -- Mum", source: `${Q} -- Mum`, quote: Q },
  { name: "<quote>\\n\\nsent by Dad", source: `${Q}\n\nsent by Dad`, quote: Q },
  { name: "<quote> (from Mum's text)", source: `${Q} (from Mum's text)`, quote: Q },
  { name: "<quote> Not me, Mum.", source: `${Q} Not me, Mum.`, quote: Q },
  // Attribution two sentences before (list verb) - expected rejected
  { name: "Mum texted. She's excited. <quote>", source: `Mum texted. She's excited. ${Q}`, quote: Q },
  // Pronoun-only attribution with verb in list
  { name: "She said something. <quote>", source: `She said something. ${Q}`, quote: Q },
  // Reported speech
  { name: "reported: She said I am moving...", source: `She said ${Q}`, quote: Q },
  // Other people speaking in first person without any attribution words (a forwarded Telegram message is its own event)
  { name: "separate event: bare forwarded text", source: Q, quote: Q },
  // Inflection variants of listed verbs
  { name: "Mum's saying. <quote>", source: `Mum keeps saying. ${Q}`, quote: Q },
  { name: "Mum was telling me. <quote>", source: `Mum was telling me. ${Q}`, quote: Q },
  { name: "Mum's texting. <quote>", source: `Mum is texting. ${Q}`, quote: Q },
  { name: "Mum's message says. <quote>", source: `Mum's message says. ${Q}`, quote: Q },
];

for (const c of cases) {
  const r = isAuthenticatedFirstPersonQuote({ quote: c.quote, sourceText: c.source, authenticatedOwner: true });
  console.log(`${r ? "ACCEPT" : "reject"}  | ${c.name} | ${JSON.stringify(c.source)}`);
}
