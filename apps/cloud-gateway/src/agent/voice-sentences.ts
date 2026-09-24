/**
 * Hold unfinished claims. Line breaks are whitespace, not proof that a claim
 * ended; splitting "I have\nsaved that" must not bypass the receipt check.
 */
export class VoiceSentences {
  private pending = "";

  push(text: string): readonly string[] {
    this.pending += text;
    const sentences: string[] = [];
    let start = 0;
    for (const match of this.pending.matchAll(/[.!?]+["'’”)]*/gu)) {
      const end = match.index + match[0].length;
      const candidate = this.pending.slice(start, end);
      if (/\b(?:mr|mrs|ms|dr|prof|st|etc|e\.g|i\.e)\.$/iu.test(candidate)
        || /\d\.$/u.test(candidate) && /\d/u.test(this.pending[end] ?? "")) continue;
      // The next byte can turn a terminal period into a decimal or abbreviation.
      // Keep its whitespace with the sentence so a second streaming boundary
      // need not wait for the same lookahead again.
      if (end === this.pending.length || !/\s/u.test(this.pending[end]!)) continue;
      if (/^\s*\d+\.$/u.test(candidate)) continue;
      let boundary = end;
      while (boundary < this.pending.length && /\s/u.test(this.pending[boundary]!)) boundary += 1;
      sentences.push(this.pending.slice(start, boundary));
      start = boundary;
    }
    this.pending = this.pending.slice(start);
    return sentences;
  }

  finish(): readonly string[] {
    const text = this.pending;
    this.pending = "";
    return text.trim().length === 0 ? [] : [text];
  }
}
