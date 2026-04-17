/**
 * Pokémon RPG Dice Roller — SillyTavern Extension
 *
 * Provides:
 *   /pdice [notation] [dc=N]  — Roll dice from the slash command bar
 *   Clickable [ROLL XdY], [AUTO-RESOLVE], [SUBMIT] buttons in AI messages
 *   DC resolution using the table from the Pokémon Vore Text Adventure ruleset
 *   Function tool so the AI can call roll_dice directly
 */

import { animation_duration, eventSource, event_types } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../../utils.js';

export { MODULE_NAME };

const MODULE_NAME = 'pokemon-dice-roller';
// Derive template path from the actual folder name so it works regardless of renaming
const SCRIPT_URL = new URL(import.meta.url);
const FOLDER_NAME = SCRIPT_URL.pathname.split('/').slice(-2, -1)[0];
const TEMPLATE_PATH = `third-party/${FOLDER_NAME}`;

const defaultSettings = Object.freeze({
    autoDetect: true,
    functionTool: false,
    showDetails: true,
    defaultFormula: '1d20',
});

// ═══════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ═══════════════════════════════════════════
//  DICE ENGINE
// ═══════════════════════════════════════════

/** Validate a dice formula using the built-in droll library */
function validate(formula) {
    return SillyTavern.libs.droll.validate(formula);
}

/** Roll using the built-in droll library */
function rollRaw(formula) {
    return SillyTavern.libs.droll.roll(formula);
}

/**
 * DC Resolution table from the Roll Protocol:
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
//  CORE ROLL FUNCTION
// ═══════════════════════════════════════════

/**
 * Perform a dice roll.
 * @param {string} formula - Dice formula (e.g. "2d6+3")
 * @param {object} [options]
 * @param {boolean} [options.quiet]  - Suppress chat output
 * @param {string}  [options.reason] - Why the roll is happening
 * @param {number|null} [options.dc] - Difficulty Class to check against
 * @param {string}  [options.who]    - Who is rolling
 * @returns {Promise<{total: string, rolls: string[], formula: string, dc: number|null}>}
 */
async function performRoll(formula, { quiet = false, reason = '', dc = null, who = '' } = {}) {
    const empty = { total: '', rolls: [], formula: '', dc: null };
    formula = (formula || '').trim();
    if (!formula) formula = getSettings().defaultFormula;

    // Normalize: "d20" → "1d20"
    if (/^d\d+/i.test(formula)) formula = '1' + formula;

    if (!validate(formula)) {
        toastr.warning(`Invalid dice formula: ${formula}`, 'Pokémon Dice Roller');
        return empty;
    }

    const result = rollRaw(formula);
    if (!result) return empty;

    const rollData = {
        total: String(result.total),
        rolls: result.rolls.map(String),
        formula,
        dc,
    };

    if (!quiet) {
        sendRollToChat(rollData, { reason, who });
    }
    return rollData;
}

/**
 * Format and send roll result as a system message.
 */
function sendRollToChat(rollData, { reason = '', who = '' } = {}) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const roller = who || context.name1;
    const reasonText = reason ? ` for "${reason}"` : '';
    const detail = settings.showDetails && rollData.rolls.length > 1 ? ` [${rollData.rolls.join(', ')}]` : '';

    let message = `🎲 ${roller} rolls ${rollData.formula}${reasonText}. Result: **${rollData.total}**${detail}`;

    if (rollData.dc != null) {
        const res = resolveVsDC(parseInt(rollData.total, 10), rollData.dc);
        message += ` vs DC ${rollData.dc}: ${res.emoji} **${res.label}** — ${res.desc}`;
    }

    context.sendSystemMessage('generic', message, { isSmallSys: true });
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

/** Process messages already on screen (restored chats) */
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
    $(document).on('click', '.pdr-roll-btn', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const btn = $(this);
        const diceStr = String(btn.data('dice'));

        // Try to extract DC from the surrounding checkpoint text
        const surroundingText = btn.closest('.mes_text').text();
        const dcMatch = surroundingText.match(/DC:\s*(\d+)/i);
        const dc = dcMatch ? parseInt(dcMatch[1], 10) : null;

        const result = await performRoll(diceStr, { dc, reason: 'Checkpoint Roll' });
        if (!result.total) return;

        const total = parseInt(result.total, 10);

        // Replace button with a "rolled" badge
        const resClass = dc != null ? resolveVsDC(total, dc).cls : '';
        const resLabel = dc != null ? ` (${resolveVsDC(total, dc).emoji} ${resolveVsDC(total, dc).label})` : '';
        btn.replaceWith(
            `<span class="pdr-rolled ${resClass}">🎲 Rolled ${diceStr}: <strong>${result.total}</strong>${resLabel}</span>`,
        );
    });

    // ── ⚡ AUTO-RESOLVE button ──
    $(document).on('click', '.pdr-auto-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).replaceWith('<span class="pdr-rolled">⚡ Auto-resolved</span>');

        const context = SillyTavern.getContext();
        context.sendSystemMessage('generic', '⚡ Player chose AUTO-RESOLVE. GM determines the outcome.', { isSmallSys: true });
    });

    // ── ⏩ SUBMIT button ──
    $(document).on('click', '.pdr-submit-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).replaceWith('<span class="pdr-rolled">⏩ Submitted</span>');

        const context = SillyTavern.getContext();
        context.sendSystemMessage('generic', '⏩ Player chose SUBMIT. Accept worst reasonable consequence.', { isSmallSys: true });
    });
}

// ═══════════════════════════════════════════
//  FUNCTION TOOL (AI-initiated rolls)
// ═══════════════════════════════════════════

function registerFunctionTools() {
    try {
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();
        if (!registerFunctionTool || !unregisterFunctionTool) {
            console.debug('[pokemon-dice-roller] Function tools not supported');
            return;
        }

        unregisterFunctionTool('pokemon_roll_dice');

        const settings = getSettings();
        if (!settings.functionTool) return;

        const rollDiceSchema = Object.freeze({
            type: 'object',
            properties: {
                who: {
                    type: 'string',
                    description: 'The name of the character or Pokémon rolling.',
                },
                formula: {
                    type: 'string',
                    description: 'Dice formula in NdS format. Examples: 1d20, 2d6, 1d20+5.',
                },
                dc: {
                    type: 'number',
                    description: 'Difficulty Class. 5=routine, 10=standard, 15=difficult, 18=very difficult, 20=extreme.',
                },
                reason: {
                    type: 'string',
                    description: 'Why the dice is being rolled, e.g. Vore Attempt, Escape Check, Attack Roll.',
                },
            },
            required: ['formula'],
        });

        registerFunctionTool({
            name: 'pokemon_roll_dice',
            displayName: 'Pokémon RPG Dice Roll',
            description: 'Roll dice for the Pokémon RPG. ALWAYS call this tool when a dice roll, check, or vore attempt is needed. Never simulate or invent dice results. Pass formula (like 1d20) and optionally dc (Difficulty Class).',
            parameters: rollDiceSchema,
            action: async (args) => {
                console.log('[pokemon-dice-roller] Function tool args:', args);

                // Sanitize args from AI
                if (typeof args === 'string') {
                    try { args = JSON.parse(args.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); } catch { args = {}; }
                }
                if (!args || typeof args !== 'object') args = {};
                for (const key of ['arguments', 'parameters', 'input']) {
                    if (args[key] && typeof args[key] === 'object') { args = args[key]; break; }
                }

                const formula = String(args.formula || args.dice || args.roll || '1d20').trim();
                const dc = args.dc != null ? parseInt(args.dc, 10) : null;
                const who = String(args.who || '').trim();
                const reason = String(args.reason || '').trim();

                const roll = await performRoll(formula, { dc, who, reason });
                if (!roll.total) return 'Dice roll failed. The formula may be invalid.';

                const whoText = who ? `${who} rolls` : 'Roll';
                const reasonText = reason ? ` for ${reason}` : '';
                let result = `${whoText} ${formula}${reasonText}. Result: ${roll.total} (individual rolls: ${roll.rolls.join(', ')})`;
                if (dc != null) {
                    const res = resolveVsDC(parseInt(roll.total, 10), dc);
                    result += `. vs DC ${dc}: ${res.label} — ${res.desc}`;
                }
                return result;
            },
            formatMessage: () => '',
        });

        console.log('[pokemon-dice-roller] Function tool registered');
    } catch (error) {
        console.error('[pokemon-dice-roller] Error registering function tools:', error);
    }
}

// ═══════════════════════════════════════════
//  EVENT LISTENER
// ═══════════════════════════════════════════

function onCharacterMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings.autoDetect) return;
    processMessage(messageId);
}

// ═══════════════════════════════════════════
//  UI SETUP
// ═══════════════════════════════════════════

async function initUI() {
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');

    // Settings panel
    const settingsContainer = $(document.getElementById('dice_container') ?? document.getElementById('extensions_settings2'));
    settingsContainer.append(settingsHtml);

    // Wand menu button
    const wandContainer = $(document.getElementById('dice_wand_container') ?? document.getElementById('extensionsMenu'));
    wandContainer.append(buttonHtml);

    // Bind settings
    const settings = getSettings();

    $('#pdr_auto_detect').prop('checked', settings.autoDetect).on('change', function () {
        settings.autoDetect = !!$(this).prop('checked');
        saveSettings();
    });

    $('#pdr_function_tool').prop('checked', settings.functionTool).on('change', function () {
        settings.functionTool = !!$(this).prop('checked');
        saveSettings();
        registerFunctionTools();
    });

    $('#pdr_show_details').prop('checked', settings.showDetails).on('change', function () {
        settings.showDetails = !!$(this).prop('checked');
        saveSettings();
    });

    $('#pdr_default_formula').val(settings.defaultFormula).on('change', function () {
        const val = String($(this).val()).trim();
        if (val && validate(val)) {
            settings.defaultFormula = val;
            saveSettings();
        } else {
            toastr.warning('Invalid default formula');
            $(this).val(settings.defaultFormula);
        }
    });

    // Quick-roll button
    $(document).on('click', '#pdr_roll_button', function () {
        performRoll(settings.defaultFormula, { reason: 'Quick Roll' });
    });
}

// ═══════════════════════════════════════════
//  SLASH COMMANDS
// ═══════════════════════════════════════════

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pdice',
        aliases: ['proll'],
        callback: async (args, value) => {
            const quiet = isTrueBoolean(String(args.quiet));
            const reason = String(args.reason || '');
            const formula = String(value || getSettings().defaultFormula).trim();

            // Parse inline DC: "1d20 dc15" or "1d20 dc 15"
            const dcInline = formula.match(/(.+?)\s+dc\s*(\d+)/i);
            const diceStr = dcInline ? dcInline[1].trim() : formula;
            const dc = dcInline
                ? parseInt(dcInline[2], 10)
                : args.dc != null
                    ? parseInt(args.dc, 10)
                    : null;

            const result = await performRoll(diceStr, { quiet, dc, reason });
            return result.total;
        },
        helpString: [
            '<div>Pokémon RPG Dice Roller with DC resolution.</div>',
            '<div><b>Examples:</b></div>',
            '<ul>',
            '<li><code>/pdice 1d20</code> — Roll a d20</li>',
            '<li><code>/pdice 1d20 dc15</code> — Roll vs DC 15</li>',
            '<li><code>/pdice dc=12 2d6+3</code> — Roll 2d6+3 vs DC 12</li>',
            '</ul>',
        ].join(''),
        returns: 'numeric roll result',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Suppress the result in chat',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: String(false),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'dc',
                description: 'Difficulty Class to roll against (5-20+)',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'reason',
                description: 'Reason for the roll (shown in chat)',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Dice formula, e.g. 1d20, 2d6+3, 1d20 dc15',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
    }));
}

// ═══════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════

jQuery(async function () {
    try {
        await initUI();
        registerFunctionTools();
        registerSlashCommands();

        // Listen for new AI messages to auto-detect [ROLL] markers
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

        // Wire up button click handlers (delegated)
        setupClickHandlers();

        // Process any messages already on screen
        processExistingMessages();

        console.log('[pokemon-dice-roller] Extension loaded');
    } catch (error) {
        console.error('[pokemon-dice-roller] Failed to initialize:', error);
    }
});
