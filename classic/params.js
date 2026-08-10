// ==========================================================================
// params.js — parses OpenSCAD "Customizer" style variable declarations
// ==========================================================================

const GROUP_RE = /^\s*\/\*\s*\[(.+?)\]\s*\*\/\s*$/;
const DECL_RE = /^(\s*)([A-Za-z_$][\w$]*)(\s*=\s*)(.+?)(;\s*(?:\/\/(.*))?)\s*$/;
const LEADING_COMMENT_RE = /^\s*\/\/(.*)$/;

/** Parse a full script into { params: [...], groupOrder: [...] } */
export function parseScadParams(script) {
    const lines = script.split('\n');
    const params = [];
    const groupOrder = [];
    let currentGroup = null;
    let pendingDescription = null;

    lines.forEach((line, i) => {
        const groupMatch = line.match(GROUP_RE);
        if (groupMatch) {
            currentGroup = groupMatch[1].trim();
            if (!groupOrder.includes(currentGroup)) groupOrder.push(currentGroup);
            pendingDescription = null;
            return;
        }

        const commentMatch = line.match(LEADING_COMMENT_RE);
        if (commentMatch) {
            pendingDescription = commentMatch[1].trim();
            return;
        }

        const declMatch = line.match(DECL_RE);
        if (!declMatch) {
            if (line.trim() !== '') pendingDescription = null;
            return;
        }

        const [, , name, , rawValue, , trailingComment] = declMatch;
        const group = currentGroup || 'Parameters';
        if (!groupOrder.includes(group)) groupOrder.push(group);

        const param = buildParam({
            name,
            rawValue: rawValue.trim(),
            comment: (trailingComment || '').trim(),
            description: pendingDescription,
            group,
            lineIndex: i,
        });

        pendingDescription = null;
        if (param) params.push(param);
    });

    return { params, groupOrder };
}

function buildParam({ name, rawValue, comment, description, group, lineIndex }) {
    const bracketMatch = comment.match(/\[(.+)\]/);
    const bracketContent = bracketMatch ? bracketMatch[1].trim() : null;
    const commentText = bracketMatch
        ? comment.slice(0, bracketMatch.index).trim()
        : comment;

    const desc = description || commentText || null;

    if (rawValue === 'true' || rawValue === 'false') {
        return {
            type: 'checkbox', name, group, lineIndex, description: desc,
            value: rawValue === 'true',
        };
    }

    if (/^".*"$/.test(rawValue)) {
        const value = rawValue.slice(1, -1);
        if (bracketContent && !isRange(bracketContent)) {
            const options = bracketContent.split(',').map((opt) => {
                const [val, label] = opt.split(':').map((s) => s.trim());
                return { value: val, label: label || val };
            });
            return { type: 'dropdown', name, group, lineIndex, description: desc, value, options, quote: true };
        }
        return { type: 'text', name, group, lineIndex, description: desc, value, quote: true };
    }

    if (/^\[.*\]$/.test(rawValue) || /[a-zA-Z(]/.test(rawValue.replace(/^-?\d/, ''))) {
        if (!/^-?\d*\.?\d+$/.test(rawValue)) {
            return { type: 'raw', name, group, lineIndex, description: desc, value: rawValue };
        }
    }

    const numValue = parseFloat(rawValue);
    if (!Number.isNaN(numValue)) {
        if (bracketContent) {
            if (isRange(bracketContent)) {
                const parts = bracketContent.split(':').map((s) => parseFloat(s.trim()));
                let min, step, max;
                if (parts.length === 3) [min, step, max] = parts;
                else[min, max] = parts, step = inferStep(min, max);
                return {
                    type: 'slider', name, group, lineIndex, description: desc,
                    value: numValue, min, max, step: step || inferStep(min, max),
                };
            }
            const options = bracketContent.split(',').map((opt) => {
                const [val, label] = opt.split(':').map((s) => s.trim());
                return { value: val, label: label || val };
            });
            return { type: 'dropdown', name, group, lineIndex, description: desc, value: rawValue, options, quote: false };
        }
        return { type: 'number', name, group, lineIndex, description: desc, value: numValue };
    }

    return { type: 'raw', name, group, lineIndex, description: desc, value: rawValue };
}

function isRange(bracketContent) {
    return /^-?\d*\.?\d+\s*:\s*-?\d*\.?\d+(\s*:\s*-?\d*\.?\d+)?$/.test(bracketContent);
}

function inferStep(min, max) {
    const span = Math.abs(max - min);
    if (span <= 2) return 0.1;
    return 1;
}

export function formatNumber(value, step) {
    const stepStr = String(step ?? 1);
    const dot = stepStr.indexOf('.');
    const decimals = dot === -1 ? 0 : stepStr.length - dot - 1;
    return decimals > 0 ? Number(value).toFixed(decimals) : String(Math.round(value));
}

export function setLineValue(lines, lineIndex, newValueLiteral) {
    const line = lines[lineIndex];
    if (line === undefined) return lines;
    const match = line.match(DECL_RE);
    if (!match) return lines;
    const [, indent, name, eq, , tail] = match;
    const updated = [...lines];
    updated[lineIndex] = `${indent}${name}${eq}${newValueLiteral}${tail}`;
    return updated;
}

export function paramToLiteral(param) {
    switch (param.type) {
        case 'checkbox':
            return param.value ? 'true' : 'false';
        case 'text':
            return `"${param.value}"`;
        case 'dropdown':
            return param.quote ? `"${param.value}"` : String(param.value);
        case 'slider':
            return formatNumber(param.value, param.step);
        case 'number':
            return String(param.value);
        case 'raw':
        default:
            return String(param.value);
    }
}