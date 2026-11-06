import { LESSON_GROUPS, type Lesson, type LessonGroup } from '@daisychess/endgames';
import { useEffect, useMemo, useRef } from 'react';
import { dueLessons, lessonMark, type LessonMark } from '../../endgames/endgamesProgress';
import { courseLessons, GROUP_TITLES, useLessonStore } from '../../endgames/lessonStore';
import { clearEndgamesGroup, useEndgamesNav } from '../../endgames/navigate';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import { LessonView } from './LessonView';
import { RookPackCard } from './RookPackCard';
import styles from './EndgamesPanel.module.css';

const MARK_TEXT: Record<LessonMark, string> = {
  new: 'new',
  done: '✓ done',
  due: 'due',
  tried: 'tried',
};

const MARK_CLASS: Record<LessonMark, string | undefined> = {
  new: styles.markNew,
  done: styles.markDone,
  due: styles.markDue,
  tried: styles.markNew,
};

const GOAL_TEXT = { win: 'win', draw: 'draw' } as const;

/** The course grouped by `LESSON_GROUPS`, with done/due marks and "Train due". */
function CourseList() {
  const progress = useLessonStore((s) => s.progress);
  const message = useLessonStore((s) => s.message);
  const store = useLessonStore.getState;
  const lock = useHumanGameLockReason();
  const focus = useEndgamesNav((s) => s.group);
  const seq = useEndgamesNav((s) => s.seq);
  const refs = useRef<Partial<Record<LessonGroup, HTMLHeadingElement | null>>>({});
  const now = Date.now();
  const lessons = courseLessons();
  const ids = useMemo(() => lessons.map((l) => l.id), [lessons]);
  const due = dueLessons(progress, now, ids);
  const byGroup = useMemo(() => {
    const m = new Map<LessonGroup, Lesson[]>();
    for (const l of lessons) m.set(l.group, [...(m.get(l.group) ?? []), l]);
    return m;
  }, [lessons]);
  const doneCount = ids.filter((id) => progress.lessons[id]?.done).length;

  // "Train this endgame" from the tour: bring the group into view and focus its heading.
  useEffect(() => {
    if (!focus) return;
    const el = refs.current[focus];
    if (el) {
      el.scrollIntoView?.({ block: 'start' });
      el.focus();
    }
    clearEndgamesGroup();
  }, [focus, seq]);

  return (
    <div className={styles.panel} data-testid="endgames-course">
      <p className={styles.intro}>
        Theoretical endgames against a perfect opponent (the tablebase). Reach the goal within the
        move budget; hints and take-backs count as mistakes.
      </p>
      {lock && <p className={styles.note}>Lessons are paused: {lockText(lock)}.</p>}
      {message && (
        <p className={styles.message} data-testid="endgames-message">
          {message}
        </p>
      )}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          disabled={due.length === 0 || lock !== null}
          data-testid="endgames-train-due"
          onClick={() => void store().trainDue()}
        >
          Train due{' '}
          <span className={styles.badge} data-testid="endgames-due-count">
            {due.length}
          </span>
        </button>
        <span className={styles.meta} data-testid="endgames-stats">
          {doneCount} of {lessons.length} lessons done
        </span>
      </div>
      {LESSON_GROUPS.map((group) => {
        const list = byGroup.get(group);
        if (!list) return null;
        const headingId = `endgames-group-${group}`;
        return (
          <section
            key={group}
            className={styles.group}
            aria-labelledby={headingId}
            data-testid={`endgames-group-${group}`}
          >
            <h3
              id={headingId}
              className={styles.groupTitle}
              tabIndex={-1}
              ref={(el) => {
                refs.current[group] = el;
              }}
            >
              {GROUP_TITLES[group]}
            </h3>
            <ul className={styles.list}>
              {list.map((l) => {
                const mark = lessonMark(progress, l.id, now);
                const markText =
                  mark === 'due' && progress.lessons[l.id]?.done ? '✓ due' : MARK_TEXT[mark];
                return (
                  <li key={l.id}>
                    <button
                      type="button"
                      className={styles.item}
                      data-testid={`lesson-${l.id}`}
                      data-mark={mark}
                      disabled={lock !== null}
                      onClick={() => void store().start(l.id)}
                    >
                      <span className={styles.name}>
                        {l.title}
                        {l.advanced && <span className={styles.tag}> · advanced</span>}
                      </span>
                      <span className={styles.tag}>
                        {l.userSide === 'white' ? 'White' : 'Black'} to {GOAL_TEXT[l.goal]}
                      </span>
                      <span className={MARK_CLASS[mark]}>{markText}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {group === 'rook_pawn' && <RookPackCard />}
          </section>
        );
      })}
      <p className={styles.note}>
        Exact results from Syzygy tablebases (on this device, or tablebase.lichess.ovh).
      </p>
    </div>
  );
}

/** The Endgames tab (ADR-025 §6): the course list, or the open lesson. */
export function EndgamesPanel() {
  const lessonId = useLessonStore((s) => s.lessonId);
  return lessonId !== undefined ? <LessonView /> : <CourseList />;
}
