import type { LoggerLike } from "./types";

export async function defaultLogErrorToFile(err: unknown, context?: string) {
    try {
        const fs = await import("node:fs");
        const path = await import("node:path");

        const timestamp = new Date().toISOString();
        const logDir = path.join(__dirname, "../../logs");
        const logFilePath = path.join(logDir, "errors_latest.log");

        if (!(await fs.promises.exists(logDir))) {
            await fs.promises.mkdir(logDir, { recursive: true });
        }
        if (!(await fs.promises.exists(logFilePath))) {
            await fs.promises.writeFile(logFilePath, "");
        }

        const message = `[${timestamp} ${
            context ?? "UnknownContext"
        }] ${formatError(err)}\n`;

        await fs.promises.appendFile(logFilePath, message);
    } catch {
        // Silent fail for unsupported environments (e.g. browsers, Bun w/o Node fs shim)
    }
}

function formatError(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error)
        return `${error.name}: ${error.message}\n${error.stack}`;
    return JSON.stringify(error, null, 2);
}

export async function getNestLogger(source?: string): Promise<LoggerLike> {
    try {
        const nest = await import("@nestjs/common");

        if ("Logger" in nest && typeof nest.Logger === "function") {
            return new nest.Logger(source ?? "RepoBase");
        }
    } catch {
        // NestJS not available — fall back to default
    }

    return console;
}
