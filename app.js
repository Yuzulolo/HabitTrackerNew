/**
 * Habit Tracker
 *
 * State shape (persisted to localStorage):
 *   { habits: [ { id, name, description, completions: ["2026-07-29", ...] } ] }
 *
 * Dates are local-time "YYYY-MM-DD" keys, never UTC, so ticking a habit late
 * at night records the day the user actually sees on screen.
 */

const STORAGE_KEY = 'habit-tracker.v1';
const DAYS_SHOWN = 7;
const UNDO_SECONDS = 5;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const form = document.getElementById('habit-form');
const nameInput = document.getElementById('habit-name');
const descriptionInput = document.getElementById('habit-description');
const formError = document.getElementById('form-error');
const habitList = document.getElementById('habit-list');
const emptyState = document.getElementById('empty-state');
const undoBar = document.getElementById('undo-bar');
const undoMessage = document.getElementById('undo-message');
const undoButton = document.getElementById('undo-btn');
const undoCountdown = document.getElementById('undo-countdown');

let habits = load();

/** Pending removal, restorable until the 5-second window expires. */
let pendingRemoval = null;
let undoTimer = null;

/* ---------- Persistence ---------- */

function load() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (err) {
    console.warn('Could not read saved habits, starting fresh.', err);
    return [];
  }
  if (!stored || !Array.isArray(stored.habits)) return [];

  // Ignore anything malformed rather than letting one bad entry break render.
  return stored.habits
    .filter((habit) => habit && typeof habit.name === 'string')
    .map((habit) => ({
      id: typeof habit.id === 'string' ? habit.id : createId(),
      name: habit.name,
      description: typeof habit.description === 'string' ? habit.description : '',
      completions: Array.isArray(habit.completions)
        ? habit.completions.filter((day) => typeof day === 'string')
        : [],
    }));
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ habits }));
  } catch (err) {
    console.error('Could not save habits.', err);
    showError('Changes could not be saved — browser storage may be full or blocked.');
  }
}

/* ---------- Dates ---------- */

function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function todayKey() {
  return dayKey(new Date());
}

/** The last DAYS_SHOWN days, oldest first, ending with today. */
function recentDays() {
  const days = [];
  for (let offset = DAYS_SHOWN - 1; offset >= 0; offset--) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    days.push({ key: dayKey(date), label: WEEKDAYS[date.getDay()], number: date.getDate() });
  }
  return days;
}

/* ---------- Rendering ---------- */

function render() {
  habitList.replaceChildren(...habits.map(buildHabitItem));
  emptyState.hidden = habits.length > 0;
}

function buildHabitItem(habit) {
  const item = document.createElement('li');
  item.className = 'habit';
  item.dataset.id = habit.id;

  const top = document.createElement('div');
  top.className = 'habit-top';

  const heading = document.createElement('div');
  const name = document.createElement('h2');
  name.className = 'habit-name';
  name.textContent = habit.name;
  heading.append(name);

  if (habit.description) {
    const description = document.createElement('p');
    description.className = 'habit-description';
    description.textContent = habit.description;
    heading.append(description);
  }

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'btn-remove';
  removeButton.dataset.action = 'remove';
  removeButton.textContent = 'Remove';
  removeButton.setAttribute('aria-label', `Remove habit: ${habit.name}`);

  top.append(heading, removeButton);
  item.append(top, buildWeek(habit));
  return item;
}

function buildWeek(habit) {
  const week = document.createElement('div');
  week.className = 'week';
  const today = todayKey();

  for (const day of recentDays()) {
    const done = habit.completions.includes(day.key);
    const isToday = day.key === today;

    // Only today is a button — past days are a read-only record.
    const cell = document.createElement(isToday ? 'button' : 'div');
    cell.className = `day${done ? ' done' : ''}${isToday ? ' today' : ''}`;

    if (isToday) {
      cell.type = 'button';
      cell.dataset.action = 'toggle';
      cell.setAttribute('aria-pressed', String(done));
      cell.setAttribute('aria-label', `${habit.name} — ${done ? 'done' : 'not done'} today`);
    } else {
      cell.setAttribute('aria-label', `${day.key} — ${done ? 'done' : 'not done'}`);
    }

    const label = document.createElement('span');
    label.className = 'day-label';
    label.textContent = day.label;

    const number = document.createElement('span');
    number.className = 'day-number';
    number.textContent = day.number;

    cell.append(label, number);
    week.append(cell);
  }

  return week;
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  formError.textContent = '';
  formError.hidden = true;
}

/* ---------- Actions ---------- */

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function addHabit(name, description) {
  habits.push({ id: createId(), name, description, completions: [] });
  save();
  render();
}

function toggleToday(habit) {
  const today = todayKey();
  const index = habit.completions.indexOf(today);
  if (index === -1) {
    habit.completions.push(today);
  } else {
    habit.completions.splice(index, 1);
  }
  save();
  render();
}

function removeHabit(id) {
  const index = habits.findIndex((habit) => habit.id === id);
  if (index === -1) return;

  const [habit] = habits.splice(index, 1);
  save();
  render();

  // Removal is already persisted; undo restores it at its original position.
  startUndoWindow(habit, index);
}

/* ---------- Undo ---------- */

function startUndoWindow(habit, index) {
  clearInterval(undoTimer);
  pendingRemoval = { habit, index };

  let secondsLeft = UNDO_SECONDS;
  undoMessage.textContent = `Removed “${habit.name}”`;
  undoCountdown.textContent = `(${secondsLeft})`;
  undoBar.hidden = false;

  undoTimer = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      hideUndoBar();
      return;
    }
    undoCountdown.textContent = `(${secondsLeft})`;
  }, 1000);
}

function hideUndoBar() {
  clearInterval(undoTimer);
  undoTimer = null;
  pendingRemoval = null;
  undoBar.hidden = true;
}

function undoRemoval() {
  if (!pendingRemoval) return;
  const { habit, index } = pendingRemoval;
  habits.splice(Math.min(index, habits.length), 0, habit);
  save();
  render();
  hideUndoBar();
}

/* ---------- Events ---------- */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const description = descriptionInput.value.trim();

  if (!name) {
    showError('Give the habit a name.');
    nameInput.focus();
    return;
  }

  clearError();
  addHabit(name, description);
  form.reset();
  nameInput.focus();
});

habitList.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;

  const id = trigger.closest('.habit').dataset.id;
  const habit = habits.find((candidate) => candidate.id === id);
  if (!habit) return;

  if (trigger.dataset.action === 'toggle') {
    toggleToday(habit);
  } else if (trigger.dataset.action === 'remove') {
    removeHabit(id);
  }
});

undoButton.addEventListener('click', undoRemoval);

render();
