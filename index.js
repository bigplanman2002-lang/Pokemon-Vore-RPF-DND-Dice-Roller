/**
 * Pokémon RPG Dice Roller — SillyTavern Extension
 *
 * Provides:
 *   /dice [notation] [dc=N]   — Roll dice from the slash command bar
 *   Clickable [ROLL XdY], [AUTO-RESOLVE], [SUBMIT] buttons in AI messages
 *   DC resolution using the table from the Adult Pokémon Vore Text Adventure ruleset
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const EXT_NAME = 'pokemon-dice-roller';

const DEFAULT_SETTINGS = {
    autoDetect: true,
    autoTrigger: true,
};

// ═══════════════════════════════════════════
//  DICE ENGINE
// ═══════════════════════════════════════════

/** Parse "1d20", "2d6+3", "1d20-2" → { count, sides, mod } or null */
function parseDice(str) {
    const m = String(str).trim().match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
    if (!m) return null;
    return {
        count: parseInt(m[1] || '1', 10),
        sides: parseInt(m[2], 10),
        mod: parseInt(m[3] || '0', 10),
    };
}

/** Return an array of individual die results */
function rollDice(count, sides) {
    const results = [];
    for (let i = 0; i < count; i++) {
        results.push(Math.floor(Math.random() * sides) + 1);
    }
    return results;
}

/**
 * Resolution table from the Roll Protocol:
 *   Success by 5+  → Critical Success
 *   Success by 0-4 → Success
 *   Fail by 1-4    → Failure
 *   Fail by 5+     → Critical Failure
 */
function resolveVsDC(total, dc) {
    const diff = total - dc;
    if (diff >= 5) {
        return { label: 'CRITICAL SUCCESS', emoji: '🌟', desc: 'Perfect outcome, bonus benefit', cls: 'pdr-crit-success' };
    }
    if (diff >= 0) {
        return { label: 'SUCCESS', emoji: '✅', desc: 'Success with minor complication', cls: 'pdr-success' };
    }
    if (diff >= -4) {
        return { label: 'FAILURE', emoji: '❌', desc: 'Failure, partial progress', cls: 'pdr-failure' };
    }
    return { label: 'CRITICAL FAILURE', emoji: '💀', desc: 'Total failure, consequence triggers', cls: 'pdr-crit-failure' };
}

// ═══════════════════════════════════════════
//  MESSAGE HELPERS
// ═══════════════════════════════════════════

/**
 * Send text as a user message (fills the textarea and clicks Send).
 * This triggers the AI to respond automatically.
 */
function sendAsUserMessage(text) {
    const textarea = document.querySelector('#send_textarea');
    const sendBtn = document.querySelector('#send_but');
    if (!textarea || !sendBtn) return false;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    sendBtn.click();
    return true;
}

/**
 * Send a narrator / system message into the chat (visible to AI context
 * but does NOT auto-trigger a new AI response).
 */
async function sendNarrator(text) {
    try {
        const script = await import('../../../../script.js');
        if (typeof script.sendNarratorMessage === 'function') {
            await script.sendNarratorMessage(text);
            return;
        }
    } catch { /* fall through */ }

    // Fallback: inject via /sys slash command
    try {
        const slashMod = await import('../../../slash-commands.js');
        if (typeof slashMod.executeSlashCommands === 'function') {
            await slashMod.executeSlashCommands(`/sys ${text.replace(/\|/g, '\\|')}`);
            return;
        }
    } catch { /* fall through */ }

    // Last resort — toast notification
    if (typeof toastr !== 'undefined') {
        toastr.info(text.replace(/[*_`]/g, ''), '🎲 Dice Roll');
    }
}

// ═══════════════════════════════════════════
//  FORMAT HELPERS
// ═══════════════════════════════════════════

/** Compact one-liner for user messages (AI-readable) */
function formatUserRoll(diceStr, rolls, mod, total, dc) {
    let msg = `[🎲 ROLL ${diceStr.toUpperCase()} = (${rolls.join(', ')})`;
    if (mod !== 0) msg += ` ${mod > 0 ? '+' : ''}${mod}`;
    msg += ` → Total: ${total}`;
    if (dc != null) {
        const res = resolveVsDC(total, dc);
        msg += ` | vs DC ${dc}: ${res.emoji} ${res.label} — ${res.desc}`;
    }
    msg += ']';
    return msg;
}

/** Detailed markdown block for narrator messages */
function formatNarratorRoll(diceStr, rolls, mod, total, dc) {
    let msg = `🎲 **ROLL: ${diceStr.toUpperCase()}**\n`;
    msg += `Rolls: [${rolls.join(', ')}]`;
    if (mod !== 0) msg += ` (${mod > 0 ? '+' : ''}${mod})`;
    msg += `\n**Total: ${total}**`;
    if (dc != null) {
        const res = resolveVsDC(total, dc);
        msg += `\nvs DC ${dc}: ${res.emoji} **${res.label}** — ${res.desc}`;
    }
    return msg;
}

// ═══════════════════════════════════════════
//  CORE ROLL FUNCTION
// ═══════════════════════════════════════════

function executeRoll(diceStr, dc) {
    const parsed = parseDice(diceStr);
    if (!parsed) return null;

    const rolls = rollDice(parsed.count, parsed.sides);
    const total = rolls.reduce((a, b) => a + b, 0) + parsed.mod;

    return { diceStr, rolls, mod: parsed.mod, total, dc };
}

// ═══════════════════════════════════════════
//  SLASH COMMAND:  /dice
// ═══════════════════════════════════════════

async function diceCommand(namedArgs, unnamedArgs) {
    const input = String(unnamedArgs || '1d20').trim();

    // Accept inline DC:  "1d20 dc15"  or  "1d20 dc 15"
    const dcInline = input.match(/(.+?)\s+dc\s*(\d+)/i);
    const diceStr = dcInline ? dcInline[1].trim() : input;
    const dc = dcInline
        ? parseInt(dcInline[2], 10)
        : namedArgs?.dc != null
            ? parseInt(namedArgs.dc, 10)
            : null;

    const result = executeRoll(diceStr, dc);
    if (!result) {
        if (typeof toastr !== 'undefined') {
            toastr.warning('Invalid dice format. Use NdX or NdX+M (e.g. 1d20, 2d6+3)', 'Dice Roller');
        }
        return '';
    }

    await sendNarrator(formatNarratorRoll(result.diceStr, result.rolls, result.mod, result.total, result.dc));
    return String(result.total);
}

// ═══════════════════════════════════════════
//  AUTO-DETECT  [ROLL XdY]  IN AI MESSAGES
// ═══════════════════════════════════════════

function processMessage(messageId) {
    const mesText = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!mesText) return;

    const html = mesText.innerHTML;
    let modified = html;

    // [ROLL 1d20]  [ROLL 1d20+2]  etc.
    modified = modified.replace(
        /\[ROLL\s+([\dd+\-]+)\]/gi,
        (_match, dice) => `<button class="pdr-roll-btn" data-dice="${dice}">🎲 ROLL ${dice.toUpperCase()}</button>`,
    );

    // [AUTO-RESOLVE]
    modified = modified.replace(
        /\[AUTO[- ]?RESOLVE\]/gi,
        '<button class="pdr-auto-btn">⚡ AUTO-RESOLVE</button>',
    );

    // [SUBMIT]
    modified = modified.replace(
        /\[SUBMIT\]/gi,
        '<button class="pdr-submit-btn">⏩ SUBMIT</button>',
    );

    if (modified !== html) {
        mesText.innerHTML = modified;
    }
}

/** Run once at load to catch already-rendered messages in a restored chat */
function processExistingMessages() {
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const id = mes.getAttribute('mesid');
        if (id) processMessage(id);
    });
}

// ═══════════════════════════════════════════
//  CLICK HANDLERS
// ═══════════════════════════════════════════

function setupClickHandlers() {
    // ── 🎲 ROLL button ──
    $(document).on('click', '.pdr-roll-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();

        const btn = $(this);
        const diceStr = String(btn.data('dice'));

        // Try to extract DC from the surrounding checkpoint text
        const surroundingText = btn.closest('.mes_text').text();
        const dcMatch = surroundingText.match(/DC:\s*(\d+)/i);
        const dc = dcMatch ? parseInt(dcMatch[1], 10) : null;

        const result = executeRoll(diceStr, dc);
        if (!result) return;

        // Replace button with a "rolled" badge
        btn.replaceWith(
            `<span class="pdr-rolled ${dc != null ? resolveVsDC(result.total, dc).cls : ''}">`
            + `🎲 Rolled ${diceStr}: <strong>${result.total}</strong>`
            + `${dc != null ? ` (${resolveVsDC(result.total, dc).emoji} ${resolveVsDC(result.total, dc).label})` : ''}`
            + `</span>`,
        );

        // Send as user message so the AI sees the result and responds
        sendAsUserMessage(formatUserRoll(result.diceStr, result.rolls, result.mod, result.total, result.dc));
    });

    // ── ⚡ AUTO-RESOLVE button ──
    $(document).on('click', '.pdr-auto-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).replaceWith('<span class="pdr-rolled">⚡ Auto-resolved</span>');
        sendAsUserMessage('[AUTO-RESOLVE]');
    });

    // ── ⏩ SUBMIT button ──
    $(document).on('click', '.pdr-submit-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).replaceWith('<span class="pdr-rolled">⏩ Submitted</span>');
        sendAsUserMessage('[SUBMIT]');
    });
}

// ═══════════════════════════════════════════
//  EVENT LISTENER
// ═══════════════════════════════════════════

function onCharacterMessageRendered(messageId) {
    const settings = extension_settings[EXT_NAME];
    if (settings?.autoDetect === false) return;
    processMessage(messageId);
}

// ═══════════════════════════════════════════
//  REGISTER SLASH COMMANDS
// ═══════════════════════════════════════════

async function registerCommands() {
    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        const { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = await import('../../../slash-commands/SlashCommandArgument.js');

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'dice',
            callback: diceCommand,
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'dc',
                    description: 'Difficulty Class to roll against',
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'Dice notation (e.g. 1d20, 2d6+3, 1d20 dc15)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    defaultValue: '1d20',
                }),
            ],
            helpString: [
                '<div>Pokémon RPG Dice Roller.</div>',
                '<div><strong>Examples:</strong></div>',
                '<ul>',
                '<li><code>/dice 1d20</code> — Roll a d20</li>',
                '<li><code>/dice 1d20 dc15</code> — Roll a d20 vs DC 15</li>',
                '<li><code>/dice dc=12 2d6+3</code> — Roll 2d6+3 vs DC 12</li>',
                '</ul>',
            ].join(''),
        }));

        console.log(`[${EXT_NAME}] Slash command /dice registered (modern API)`);
    } catch {
        // Fallback: legacy registerSlashCommand
        try {
            const { registerSlashCommand } = await import('../../../slash-commands.js');
            registerSlashCommand('dice', diceCommand, [], '<code>/dice 1d20 dc15</code> — Roll dice for the Pokémon RPG');
            console.log(`[${EXT_NAME}] Slash command /dice registered (legacy API)`);
        } catch (err) {
            console.error(`[${EXT_NAME}] Could not register /dice command:`, err);
        }
    }
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════

jQuery(async () => {
    // Initialise settings
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = Object.assign({}, DEFAULT_SETTINGS);
    }

    // Register slash commands
    await registerCommands();

    // Listen for new AI messages
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

    // Wire up button click handlers (delegated, so works for future elements)
    setupClickHandlers();

    // Process any messages already on screen (restored chat)
    processExistingMessages();

    console.log(`[${EXT_NAME}] Extension loaded`);
});
