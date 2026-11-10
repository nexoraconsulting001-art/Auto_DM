/** When an automation may send (PRD 6.8). Pure: everything is worked out from the schedule, a moment and a time zone. */

const DAY_MINUTES = 24 * 60;
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

const toMinutes = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

function clock(date, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  } catch {
    return clock(date, DEFAULT_TIME_ZONE); // a time zone this runtime doesn't know
  }
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  return { minutes: part('hour') * 60 + part('minute'), seconds: part('second') };
}

const within = (minute, start, end) => (start < end ? minute >= start && minute < end : minute >= start || minute < end);

/**
 * { open: true }, { ended: true } once the end time has passed, or { open: false, nextOpenAt } with the next moment it
 * may send. Daily hours may cross midnight. An hour with no daily window is open all day.
 */
export function scheduleStatus(schedule, now, timeZone = DEFAULT_TIME_ZONE) {
  const startsAt = schedule.startsAt ? new Date(schedule.startsAt) : null;
  const endsAt = schedule.endsAt ? new Date(schedule.endsAt) : null;
  if (endsAt && now >= endsAt) return { ended: true };
  const from = startsAt && now < startsAt ? startsAt : now;
  if (!schedule.dailyStart || !schedule.dailyEnd) return from === now ? { open: true } : { open: false, nextOpenAt: from };

  const start = toMinutes(schedule.dailyStart);
  const end = toMinutes(schedule.dailyEnd);
  const here = clock(from, timeZone);
  if (within(here.minutes, start, end)) return from === now ? { open: true } : { open: false, nextOpenAt: from };

  const wait = ((start - here.minutes + DAY_MINUTES) % DAY_MINUTES) * 60_000 - here.seconds * 1000;
  return { open: false, nextOpenAt: new Date(from.getTime() + wait) };
}
