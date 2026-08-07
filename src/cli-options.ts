export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CliOptions {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--yolo" || arg === "--dangerously-bypass-approvals-and-sandbox") {
      options.approvalPolicy = "never";
      options.sandbox = "danger-full-access";
      continue;
    }

    const sandboxValue = readOptionValue(args, index, arg, "-s", "--sandbox");
    if (sandboxValue) {
      if (!isSandboxMode(sandboxValue.value))
        throw new Error(`invalid sandbox mode: ${sandboxValue.value}`);
      options.sandbox = sandboxValue.value;
      index = sandboxValue.nextIndex;
      continue;
    }

    const approvalValue = readOptionValue(args, index, arg, "-a", "--ask-for-approval");
    if (approvalValue) {
      if (!isApprovalPolicy(approvalValue.value))
        throw new Error(`invalid approval policy: ${approvalValue.value}`);
      options.approvalPolicy = approvalValue.value;
      index = approvalValue.nextIndex;
      continue;
    }

    throw new Error(`unsupported option: ${arg}`);
  }
  return options;
}

function readOptionValue(args: string[], index: number, arg: string, shortName: string, longName: string) {
  if (arg === shortName || arg === longName) {
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    return { value, nextIndex: index + 1 };
  }
  if (arg.startsWith(`${longName}=`))
    return { value: arg.slice(longName.length + 1), nextIndex: index };
  return null;
}

function isSandboxMode(value: string): value is SandboxMode {
  return ["read-only", "workspace-write", "danger-full-access"].includes(value);
}

function isApprovalPolicy(value: string): value is ApprovalPolicy {
  return ["untrusted", "on-request", "never"].includes(value);
}
