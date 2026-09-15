const MONTH_WORDS = ["jan(?:uary)?","feb(?:ruary)?","mar(?:ch)?","apr(?:il)?","may","jun(?:e)?","jul(?:y)?","aug(?:ust)?","sep(?:t(?:ember)?)?","oct(?:ober)?","nov(?:ember)?","dec(?:ember)?"];
const B = String.fromCharCode(92) + "b";
for (const [e, d] of [
  ["Waterloo AIF due Feb 1, 2027; I have 15 essays to plan", "2027-02-15"],
  ["the essay may be due in 2027, maybe the 3rd week", "2027-05-03"],
  ["Waterloo AIF due February 1, 2027", "2027-02-01"],
]) {
  const [year, month, day] = d.split("-");
  const lower = e.toLowerCase();
  const y = new RegExp(B + year + B, "u").test(lower);
  const m = new RegExp(B + MONTH_WORDS[Number(month) - 1] + B, "iu").test(lower);
  const dd = new RegExp(B + "0?" + String(Number(day)) + "(?:st|nd|rd|th)?" + B, "iu").test(lower);
  console.log({ e, d, y, m, dd, accepted: y && m && dd });
}
