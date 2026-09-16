/**
 * Split a migration into the statements D1 applies one at a time.
 *
 * Triggers are lifted out first because their bodies contain the semicolons
 * this otherwise splits on. Comment lines directly above a trigger travel
 * with it so they cannot become an orphaned fragment.
 *
 * Semicolons inside comments elsewhere still cut a statement in half, which
 * surfaces as `incomplete input` from D1. Migrations avoid them.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitMigration(sql) {
  const triggers = [];
  const statements = sql.replace(/(?:^[^\S\n]*--[^\n]*\n)*CREATE TRIGGER\b[\s\S]*?\nEND;/gimu, (trigger) => {
    const marker = `__JARVIS_TRIGGER_${triggers.length}__`;
    triggers.push(trigger.slice(0, -1));
    return `${marker};`;
  });
  return statements.split(';').map((query) => query.trim()).filter(Boolean).map((query) => {
    const marker = /^__JARVIS_TRIGGER_(\d+)__$/u.exec(query);
    return marker === null ? query : (triggers[Number(marker[1])] ?? query);
  });
}
