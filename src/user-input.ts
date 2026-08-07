export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export function toAppQuestions(questions: CodexUserInputQuestion[]) {
  return questions.map((question) => ({
    header: question.header,
    question: question.question,
    options: question.options ?? [],
    multiSelect: false,
  }));
}

export function toCodexAnswers(questions: CodexUserInputQuestion[], appAnswer: string) {
  const blocks = appAnswer.split(/\n\s*\n/);
  const answers: Record<string, { answers: string[] }> = {};
  questions.forEach((question, index) => {
    const block = blocks[index] ?? (index === 0 ? appAnswer : "");
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const value = lines.at(-1) ?? "";
    answers[question.id] = {
      answers: value.split(",").map((answer) => answer.trim()).filter(Boolean),
    };
  });
  return { answers };
}
