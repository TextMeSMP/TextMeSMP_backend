import fs from 'node:fs/promises';
import path from 'node:path';

type RoleLevel = 'agent' | 'lead' | 'supervisor' | 'manager' | 'executive';
type Lesson = {
  role_level: RoleLevel;
  day_number: number;
  title: string;
  lesson_text: string;
  action_text: string;
  reflection_question: string;
};

type Theme = {
  title: string;
  focus: string[];
};

const dataDirectory = path.resolve(process.cwd(), 'data', 'lessons');

const managerThemes: Theme[] = [
  { title: 'Setting Clear Team Priorities', focus: ['define the most important outcome', 'translate goals into observable work', 'remove competing priorities', 'confirm ownership and deadlines', 'review progress without micromanaging'] },
  { title: 'Coaching for Better Performance', focus: ['prepare with evidence', 'ask before advising', 'name the performance gap clearly', 'agree on one behavior to practice', 'follow up and reinforce progress'] },
  { title: 'Delegation and Accountability', focus: ['delegate outcomes rather than tasks', 'match responsibility to readiness', 'set decision boundaries', 'create useful checkpoints', 'address missed commitments promptly'] },
  { title: 'Leading Through Conflict', focus: ['separate facts from assumptions', 'surface disagreement early', 'keep difficult conversations respectful', 'resolve the decision and relationship', 'document agreements and next steps'] },
  { title: 'Using Data to Lead', focus: ['choose a meaningful team measure', 'look for trends instead of isolated results', 'connect metrics to behavior', 'test one improvement action', 'share learning with the team'] },
  { title: 'Building a Strong Team Culture', focus: ['model the expected standard', 'recognize specific contributions', 'invite constructive challenge', 'protect psychological safety', 'create a repeatable team ritual'] },
];

const executiveThemes: Theme[] = [
  { title: 'Strategic Clarity', focus: ['state the organization’s defining priority', 'identify what the organization will not pursue', 'connect strategy to customer value', 'test assumptions behind the strategy', 'communicate the strategy in plain language'] },
  { title: 'Enterprise Decision-Making', focus: ['define the decision and decision owner', 'distinguish reversible from irreversible choices', 'use evidence without waiting for certainty', 'include affected perspectives', 'communicate tradeoffs after deciding'] },
  { title: 'Leading Organizational Change', focus: ['explain why change is necessary', 'identify the behaviors that must change', 'equip leaders to reinforce the change', 'listen for resistance and useful feedback', 'measure adoption instead of activity'] },
  { title: 'Executive Talent Stewardship', focus: ['identify critical future capabilities', 'review succession risk honestly', 'develop leaders through meaningful assignments', 'address leadership behavior that harms culture', 'make advancement criteria transparent'] },
  { title: 'Risk and Operational Resilience', focus: ['name the highest-impact risk', 'clarify early warning indicators', 'assign accountable risk owners', 'practice a response scenario', 'capture lessons and improve controls'] },
  { title: 'Sustainable Enterprise Performance', focus: ['balance short- and long-term results', 'connect investment to strategic outcomes', 'remove structural friction', 'review stakeholder impact', 'set the next leadership commitment'] },
];

const supervisorGapThemes: Theme[] = [
  { title: 'Managing Daily Workflow', focus: ['set a clear shift priority', 'balance work across the team', 'spot a bottleneck early', 'adjust resources calmly', 'close the day with an accurate handoff'] },
  { title: 'Quality and Consistency', focus: ['define one quality standard', 'observe work against the standard', 'correct drift with specific feedback', 'recognize consistent execution', 'verify that the correction lasted'] },
  { title: 'Attendance and Reliability', focus: ['set a fair reliability expectation', 'document patterns objectively', 'hold a timely attendance conversation', 'apply policy consistently', 'protect coverage while supporting the employee'] },
  { title: 'Escalation Management', focus: ['recognize when escalation is necessary', 'collect facts before responding', 'stabilize the immediate situation', 'communicate ownership and next steps', 'prevent the issue from recurring'] },
  { title: 'Preparing Future Team Leads', focus: ['notice informal leadership', 'assign a small leadership responsibility', 'coach decision-making instead of giving answers', 'observe influence on peers', 'give readiness feedback with a next step'] },
];

function cleanText(value: string): string {
  return value.split('⸻')[0].replace(/\s+/g, ' ').trim();
}

function cleanLesson(lesson: Lesson): Lesson {
  return {
    ...lesson,
    title: cleanText(lesson.title),
    lesson_text: cleanText(lesson.lesson_text),
    action_text: cleanText(lesson.action_text),
    reflection_question: cleanText(lesson.reflection_question),
  };
}

function buildLessons(role: RoleLevel, themes: Theme[], firstDay = 1): Lesson[] {
  return themes.flatMap((theme, themeIndex) =>
    theme.focus.map((focus, dayIndex) => {
      const day = firstDay + themeIndex * 5 + dayIndex;
      return {
        role_level: role,
        day_number: day,
        title: theme.title,
        lesson_text: `Effective ${theme.title.toLowerCase()} requires leaders to ${focus}. Clarity becomes useful only when people can see it in everyday decisions and behavior.`,
        action_text: `Today, ${focus}. Write down the expected result, communicate it to the people involved, and check what changed before the end of the day.`,
        reflection_question: `How effectively did you ${focus}, and what evidence shows the impact?`,
      };
    }),
  );
}

async function readLessons(name: string): Promise<Lesson[]> {
  return JSON.parse(await fs.readFile(path.join(dataDirectory, `${name}.json`), 'utf8')) as Lesson[];
}

async function writeLessons(name: string, lessons: Lesson[]) {
  const sorted = lessons.sort((a, b) => a.day_number - b.day_number);
  await fs.writeFile(path.join(dataDirectory, `${name}.json`), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

async function main() {
  for (const role of ['agent', 'lead', 'supervisor'] as const) {
    const existing = (await readLessons(role)).map(cleanLesson);
    if (role === 'supervisor') {
      const additions = buildLessons('supervisor', supervisorGapThemes, 101);
      const additionDays = new Set(additions.map((lesson) => lesson.day_number));
      await writeLessons(role, [...existing.filter((lesson) => !additionDays.has(lesson.day_number)), ...additions]);
    } else {
      await writeLessons(role, existing);
    }
  }

  await writeLessons('manager', buildLessons('manager', managerThemes));
  await writeLessons('executive', buildLessons('executive', executiveThemes));
  console.log('Lesson curriculum files prepared successfully.');
}

void main();
