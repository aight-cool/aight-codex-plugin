import { describe, expect, test } from "bun:test";
import { toAppQuestions, toCodexAnswers } from "../user-input";

const questions = [
  {
    id: "database",
    header: "Database",
    question: "Which database?",
    isOther: true,
    isSecret: false,
    options: [
      { label: "SQLite", description: "Local file" },
      { label: "Postgres", description: "Server database" },
    ],
  },
  {
    id: "deploy",
    header: "Deploy",
    question: "Deploy now?",
    isOther: false,
    isSecret: false,
    options: [
      { label: "Yes", description: "Deploy it" },
      { label: "No", description: "Keep it local" },
    ],
  },
];

describe("Codex user input bridge", () => {
  test("maps Codex questions to the app question-card shape", () => {
    expect(toAppQuestions(questions)).toEqual([
      {
        header: "Database",
        question: "Which database?",
        options: questions[0]!.options,
        multiSelect: false,
      },
      {
        header: "Deploy",
        question: "Deploy now?",
        options: questions[1]!.options,
        multiSelect: false,
      },
    ]);
  });

  test("maps the app card answer back to Codex question ids", () => {
    expect(
      toCodexAnswers(questions, "Which database?\nSQLite\n\nDeploy now?\nYes"),
    ).toEqual({
      answers: {
        database: { answers: ["SQLite"] },
        deploy: { answers: ["Yes"] },
      },
    });
  });

  test("maps a single free-form answer", () => {
    expect(toCodexAnswers([questions[0]!], "Something else")).toEqual({
      answers: { database: { answers: ["Something else"] } },
    });
  });
});
