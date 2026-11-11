export interface MatchedError {
	line: number;
	text: string;
}

export interface SentinelSummaryResult {
	totalLines: number;
	errorCount: number;
	matchedErrors: MatchedError[];
}

export interface LogExcerptResult {
	startLine: number;
	endLine: number;
	lines: string[];
	hasMore: boolean;
}

const ERROR_PATTERN = /error|failed|exception|panic|assertionerror/i;

export class RollingLogBuffer {
	private lines: string[] = [];
	private maxBufferLines: number;

	constructor(maxBufferLines = 5000) {
		this.maxBufferLines = maxBufferLines;
	}

	ingestLogChunk(chunk: string): void {
		if (!chunk) return;
		const splitLines = chunk.split(/\r?\n/);
		if (splitLines.length > 1 && splitLines[splitLines.length - 1] === "") splitLines.pop();
		if (this.lines.length + splitLines.length > this.maxBufferLines) {
			const excess = this.lines.length + splitLines.length - this.maxBufferLines;
			if (excess >= this.lines.length) {
				this.lines = splitLines.slice(splitLines.length - this.maxBufferLines);
				return;
			}
			this.lines.splice(0, excess);
		}
		this.lines.push(...splitLines);
	}

	queryTelemetrySentinel(query?: string): SentinelSummaryResult {
		const q = query ? query.toLowerCase() : "";
		const matchedErrors: MatchedError[] = [];
		for (let i = 0; i < this.lines.length; i++) {
			const text = this.lines[i];
			if (ERROR_PATTERN.test(text) && (!q || text.toLowerCase().includes(q))) {
				matchedErrors.push({ line: i + 1, text });
			}
		}
		return { totalLines: this.lines.length, errorCount: matchedErrors.length, matchedErrors };
	}

	queryLogExcerpt(offset: number, maxLines = 50): LogExcerptResult {
		const clamped = Math.min(Math.max(1, maxLines || 50), 50);
		const startIdx = Math.max(0, Math.floor(offset));
		const sliced = this.lines.slice(startIdx, startIdx + clamped);
		return {
			startLine: sliced.length > 0 ? startIdx + 1 : 0,
			endLine: sliced.length > 0 ? startIdx + sliced.length : 0,
			lines: sliced,
			hasMore: startIdx + sliced.length < this.lines.length,
		};
	}

	getLineCount(): number {
		return this.lines.length;
	}
	clear(): void {
		this.lines = [];
	}
}

const defaultSentinelBuffer = new RollingLogBuffer();

export function getSentinelBuffer(): RollingLogBuffer {
	return defaultSentinelBuffer;
}
export function ingestLogChunk(chunk: string): void {
	defaultSentinelBuffer.ingestLogChunk(chunk);
}
export function queryTelemetrySentinel(query?: string): SentinelSummaryResult {
	return defaultSentinelBuffer.queryTelemetrySentinel(query);
}
export function queryLogExcerpt(offset: number, maxLines = 50): LogExcerptResult {
	return defaultSentinelBuffer.queryLogExcerpt(offset, maxLines);
}
