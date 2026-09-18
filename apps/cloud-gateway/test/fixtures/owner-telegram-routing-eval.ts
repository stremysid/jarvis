export type ExpectedOwnerTelegramTool =
  | "memory_remember"
  | "memory_forget"
  | "memory_restore"
  | "memory_confirm"
  | "memory_explain"
  | "school_update"
  | "university_update"
  | "study_coach"
  | null;

export interface OwnerTelegramRoutingCase {
  readonly message: string;
  readonly expectedTool: ExpectedOwnerTelegramTool;
  readonly previousJarvis?: string;
}

function cases(
  expectedTool: ExpectedOwnerTelegramTool,
  messages: readonly (string | readonly [message: string, previousJarvis: string])[],
): readonly OwnerTelegramRoutingCase[] {
  return messages.map((entry) => typeof entry === "string"
    ? Object.freeze({ message: entry, expectedTool })
    : Object.freeze({ message: entry[0], previousJarvis: entry[1], expectedTool }));
}

/** Held out from prompts and fake-provider unit tests. Reviewers may run these against the configured real model. */
export const OWNER_TELEGRAM_ROUTING_EVAL = Object.freeze([
  ...cases("memory_remember", [
    "Remeber my favourite soup is pho",
    "yo keep in mind i hate early meetings",
    "save this for later: my locker is 214",
    "rember that I learn better with diagrams",
    "Jarvis don't lose this, aunt Maya is allergic to peanuts",
    "note for ur brain i use the side entrance",
    "remember I decided to take calculus next term",
    "pls remember my coach calls me Sid not Sidney",
    "keep this in memory: I prefer short answers",
    "store that my backup contact is my brother",
    ["Math", "Want me to note your favourite subject?"],
    ["yea the blue one", "Should I remember which notebook you mean?"],
    ["Friday mornings", "Want me to remember when you focus best?"],
    ["nah, physics", "Should I note that chemistry is your favourite?"],
    ["Mom", "Who should I remember as your emergency contact?"],
  ]),
  ...cases("memory_forget", [
    "forget that thing about me liking pho",
    "delete the memory you just mentioned",
    "dont remember my locker number anymore",
    "wipe those two preferences",
    "forget both of them pls",
    "remove that from ur brain",
    "the old phone number, forget it",
    "stop using that memory about morning study",
  ]),
  ...cases("memory_restore", [
    "use that memory again",
    "undo forgetting my study preference",
    "bring the hidden locker memory back",
    "restore the one you just removed",
    "actually keep remembering that",
  ]),
  ...cases("memory_confirm", [
    "yes that's true",
    "confirm the uncertain one about art",
    "yup you inferred that right",
    "make that proposed memory official",
    "yeah I really do prefer diagrams",
  ]),
  ...cases("memory_explain", [
    "why do you think I like diagrams",
    "show me the evidence for that memory",
    "where did that locker fact come from",
    "explain why you remember the math thing",
    "what source backs that memory",
  ]),
  ...cases("school_update", [
    "chem lab is due friday and i havent started",
    "I finished the English essay",
    "math test got moved to monday",
    "add physics as one of my courses",
    "I missed the bio worksheet yesterday",
    "classroom says the history project is overdue",
    "my weak spot in calc is related rates",
    "mark the titration review done",
    "english uses brightspace btw",
    "plan 30 mins for vectors tonight",
    "I have no missing work in chemistry now",
    "course update: dropped computer science",
  ]),
  ...cases("university_update", [
    "Waterloo sent me an offer today",
    "mark my Western essay as submitted by me",
    "I paid the OUAC fee myself",
    "add McMaster engineering to my programs",
    "Queens application is still drafting",
    "my Waterloo AIF is ready but not submitted",
    "I requested my transcript from guidance",
    "remove the unverified UBC deadline",
    "record that I accepted Western on OUAC",
    "the McGill interview is booked for March 3",
  ]),
  ...cases("study_coach", [
    "quiz me on derivatives",
    "start a 20 minute chem practice block",
    "I studied vectors for 35 mins",
    "that last question was too easy",
    "give me another stoichiometry question",
    "my answer is 4.2 moles",
    "end the study session",
    "log that I got related rates wrong again",
    "make tonight's practice harder",
    "how did I do in that quiz",
  ]),
  ...cases(null, [
    "yo whats up",
    "what does derivative mean",
    "draft an email to Ms Lee asking for a reference",
    "can you explain photosynthesis simply",
    "I already emailed the registrar",
    "don't email anyone, just write the draft",
    "what should I study first tonight",
    "I can't focus rn",
    "tell me a bad joke",
    "is Waterloo good for computer science",
    "thanks",
    "nah",
    "what did I just say",
    "help me word this: I need an extension",
    "could you remind me what a vector is",
  ]),
]);
