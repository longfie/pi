import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("configured Git package refs", () => {
	let tempDir: string;
	let remoteDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let originalHead: string;
	let updatedHead: string;
	const source = "git:example.invalid/owner/package";

	function git(cwd: string, ...args: string[]): string {
		return execFileSync(
			"git",
			["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
			{ cwd, encoding: "utf8" },
		).trim();
	}

	function checkout(scope: "user" | "project" = "user"): string {
		const root = scope === "user" ? agentDir : join(tempDir, ".pi");
		const installedPath = join(root, "git", "example.invalid", "owner", "package");
		mkdirSync(dirname(installedPath), { recursive: true });
		git(tempDir, "clone", "--quiet", remoteDir, installedPath);
		git(installedPath, "checkout", "--quiet", "--detach", originalHead);
		return installedPath;
	}

	beforeEach(() => {
		allowNetwork(); // All fetches use a local fixture, never the configured example.invalid URL.
		tempDir = mkdtempSync(join(tmpdir(), "pi-git-ref-"));
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("GIT_CONFIG_GLOBAL", join(tempDir, "gitconfig"));
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z");
		vi.stubEnv("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z");
		agentDir = join(tempDir, "agent");
		remoteDir = join(tempDir, "remote");
		mkdirSync(join(remoteDir, "extensions"), { recursive: true });
		git(remoteDir, "init", "--quiet", "--initial-branch=main");
		writeFileSync(join(remoteDir, "extensions", "index.ts"), "export const version = 1;\n");
		git(remoteDir, "add", "extensions/index.ts");
		git(remoteDir, "commit", "--quiet", "-m", "First version");
		originalHead = git(remoteDir, "rev-parse", "HEAD");
		writeFileSync(join(remoteDir, "extensions", "index.ts"), "export const version = 2;\n");
		git(remoteDir, "commit", "--quiet", "-am", "Second version");
		updatedHead = git(remoteDir, "rev-parse", "HEAD");
		git(remoteDir, "tag", "-a", "v2", "-m", "Second version");
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	// https://github.com/earendil-works/pi/issues/10758
	it.each(["user", "project"] as const)("reconciles a changed SHA in %s settings on resolve", async (scope) => {
		const installedPath = checkout(scope);
		if (scope === "user") settingsManager.setPackages([`${source}@${updatedHead}`]);
		else settingsManager.setProjectPackages([`${source}@${updatedHead}`]);

		const result = await packageManager.resolve();

		expect(git(installedPath, "rev-parse", "HEAD")).toBe(updatedHead);
		expect(readFileSync(join(installedPath, "extensions", "index.ts"), "utf8")).toBe("export const version = 2;\n");
		expect(result.extensions.some((entry) => entry.path === join(installedPath, "extensions", "index.ts"))).toBe(
			true,
		);
	});

	it.each(["v2", "main"])("reconciles a changed named ref %s", async (ref) => {
		const installedPath = checkout();
		settingsManager.setPackages([`${source}@${ref}`]);
		await packageManager.resolve();
		expect(git(installedPath, "rev-parse", "HEAD")).toBe(updatedHead);
	});

	it("fetches a configured commit that is not in the existing clone", async () => {
		const installedPath = checkout();
		writeFileSync(join(remoteDir, "extensions", "index.ts"), "export const version = 3;\n");
		git(remoteDir, "commit", "--quiet", "-am", "Third version");
		const newHead = git(remoteDir, "rev-parse", "HEAD");
		settingsManager.setPackages([`${source}@${newHead}`]);
		await packageManager.resolve();
		expect(git(installedPath, "rev-parse", "HEAD")).toBe(newHead);
	});

	it.each(["sha", "tag", "unpinned"])("does not fetch or clean a matching %s checkout", async (kind) => {
		const installedPath = checkout();
		git(installedPath, "tag", "-a", "v1", "-m", "First version");
		const ref = kind === "sha" ? `@${originalHead}` : kind === "tag" ? "@v1" : "";
		settingsManager.setPackages([`${source}${ref}`]);
		writeFileSync(join(installedPath, "keep.txt"), "local data");
		rmSync(remoteDir, { recursive: true, force: true });
		const result = await packageManager.resolve();
		expect(result.extensions).toHaveLength(1);
		expect(git(installedPath, "rev-parse", "HEAD")).toBe(originalHead);
		expect(readFileSync(join(installedPath, "keep.txt"), "utf8")).toBe("local data");
	});

	it("does not load a mismatched checkout when offline", async () => {
		const installedPath = checkout();
		settingsManager.setPackages([`${source}@${updatedHead}`]);
		vi.stubEnv("PI_OFFLINE", "1");
		const result = await packageManager.resolve();
		expect(result.extensions).toEqual([]);
		expect(git(installedPath, "rev-parse", "HEAD")).toBe(originalHead);
	});

	it("honors a skipped reinstall rather than loading the old pin", async () => {
		const installedPath = checkout();
		settingsManager.setPackages([`${source}@${updatedHead}`]);
		const onMissing = vi.fn(async () => "skip" as const);
		const result = await packageManager.resolve(onMissing);
		expect(onMissing).toHaveBeenCalledWith(`${source}@${updatedHead}`);
		expect(result.extensions).toEqual([]);
		expect(git(installedPath, "rev-parse", "HEAD")).toBe(originalHead);
	});

	it("rejects an invalid ref instead of loading the previous checkout", async () => {
		const installedPath = checkout();
		settingsManager.setPackages([`${source}@missing-ref`]);
		await expect(packageManager.resolve()).rejects.toThrow();
		expect(git(installedPath, "rev-parse", "HEAD")).toBe(originalHead);
	});
});
