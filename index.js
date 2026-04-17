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
//  TYPE EFFECTIVENESS CHART
// ═══════════════════════════════════════════

/** Attacking type → { se: super-effective targets, nve: not-very-effective, imm: immune } */
const TYPE_CHART = {
    Normal:   { se: [],                                            nve: ['Rock', 'Steel'],                                                    imm: ['Ghost'] },
    Fire:     { se: ['Grass', 'Ice', 'Bug', 'Steel'],             nve: ['Fire', 'Water', 'Rock', 'Dragon'],                                  imm: [] },
    Water:    { se: ['Fire', 'Ground', 'Rock'],                    nve: ['Water', 'Grass', 'Dragon'],                                         imm: [] },
    Electric: { se: ['Water', 'Flying'],                           nve: ['Electric', 'Grass', 'Dragon'],                                      imm: ['Ground'] },
    Grass:    { se: ['Water', 'Ground', 'Rock'],                   nve: ['Fire', 'Grass', 'Poison', 'Flying', 'Bug', 'Dragon', 'Steel'],      imm: [] },
    Ice:      { se: ['Grass', 'Ground', 'Flying', 'Dragon'],      nve: ['Fire', 'Water', 'Ice', 'Steel'],                                    imm: [] },
    Fighting: { se: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'],   nve: ['Poison', 'Flying', 'Psychic', 'Bug', 'Fairy'],                      imm: ['Ghost'] },
    Poison:   { se: ['Grass', 'Fairy'],                            nve: ['Poison', 'Ground', 'Rock', 'Ghost'],                                imm: ['Steel'] },
    Ground:   { se: ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'], nve: ['Grass', 'Bug'],                                                  imm: ['Flying'] },
    Flying:   { se: ['Grass', 'Fighting', 'Bug'],                  nve: ['Electric', 'Rock', 'Steel'],                                        imm: [] },
    Psychic:  { se: ['Fighting', 'Poison'],                        nve: ['Psychic', 'Steel'],                                                 imm: ['Dark'] },
    Bug:      { se: ['Grass', 'Psychic', 'Dark'],                  nve: ['Fire', 'Fighting', 'Poison', 'Flying', 'Ghost', 'Steel', 'Fairy'],  imm: [] },
    Rock:     { se: ['Fire', 'Ice', 'Flying', 'Bug'],              nve: ['Fighting', 'Ground', 'Steel'],                                      imm: [] },
    Ghost:    { se: ['Psychic', 'Ghost'],                          nve: ['Dark'],                                                             imm: ['Normal'] },
    Dragon:   { se: ['Dragon'],                                    nve: ['Steel'],                                                            imm: ['Fairy'] },
    Dark:     { se: ['Psychic', 'Ghost'],                          nve: ['Fighting', 'Dark', 'Fairy'],                                        imm: [] },
    Steel:    { se: ['Ice', 'Rock', 'Fairy'],                      nve: ['Fire', 'Water', 'Electric', 'Steel'],                               imm: [] },
    Fairy:    { se: ['Fighting', 'Dragon', 'Dark'],                nve: ['Fire', 'Poison', 'Steel'],                                          imm: [] },
};

function getTypeEffectiveness(atkType, defTypes) {
    const entry = TYPE_CHART[atkType];
    if (!entry) return { multiplier: 1, label: 'unknown type' };
    let mult = 1;
    for (const dt of defTypes) {
        if (entry.se.includes(dt)) mult *= 2;
        else if (entry.nve.includes(dt)) mult *= 0.5;
        else if (entry.imm.includes(dt)) mult *= 0;
    }
    if (mult === 0)    return { multiplier: 0, label: 'no effect' };
    if (mult >= 4)     return { multiplier: mult, label: 'double super effective' };
    if (mult >= 2)     return { multiplier: mult, label: 'super effective' };
    if (mult <= 0.25)  return { multiplier: mult, label: 'double resisted' };
    if (mult <= 0.5)   return { multiplier: mult, label: 'not very effective' };
    return { multiplier: 1, label: 'neutral' };
}

// ═══════════════════════════════════════════
//  RUNTIME BATTLE STATE
// ═══════════════════════════════════════════

const battleState = {
    active: false,
    type: '',
    opponent: '',
    allies: [],
    enemies: [],
    vore: [],
};

function findCombatant(name) {
    const n = name.toLowerCase();
    return battleState.allies.find(c => c.name.toLowerCase() === n || c.species.toLowerCase() === n)
        || battleState.enemies.find(c => c.name.toLowerCase() === n || c.species.toLowerCase() === n);
}

function formatCombatant(c) {
    const status = c.status.length ? ` [${c.status.join(', ')}]` : '';
    return `${c.name} (${c.species}) Lv.${c.level} HP: ${c.hp}/${c.maxHp} STM: ${c.stm}/${c.maxStm}${status}`;
}

function formatBattleState() {
    if (!battleState.active) return 'No active battle.';
    const allies = battleState.allies.map(formatCombatant).join('\n');
    const enemies = battleState.enemies.map(formatCombatant).join('\n');
    const voreActive = battleState.vore.filter(v => !['digested', 'released', 'escaped'].includes(v.phase));
    const voreStr = voreActive.length ? `\n\nVore: ${voreActive.map(v => `${v.pred}→${v.prey} (${v.phase}, ${v.turns}t${v.fatal ? ', fatal' : ''})`).join(', ')}` : '';
    return `**${battleState.type}${battleState.opponent ? ' — ' + battleState.opponent : ''}**\n\nAllies:\n${allies}\n\nEnemies:\n${enemies}${voreStr}`;
}

/** Sanitize args that the AI passes to function tools */
function sanitizeToolArgs(args) {
    if (typeof args === 'string') {
        try { args = JSON.parse(args.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); } catch { args = {}; }
    }
    if (!args || typeof args !== 'object') args = {};
    for (const key of ['arguments', 'parameters', 'input']) {
        if (args[key] && typeof args[key] === 'object') { args = args[key]; break; }
    }
    return args;
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
//  FUNCTION TOOLS (AI-initiated)
// ═══════════════════════════════════════════

const ALL_TOOL_NAMES = Object.freeze([
    'pokemon_roll_dice',
    'pokemon_checkpoint',
    'pokemon_battle_start',
    'pokemon_battle_update',
    'pokemon_type_check',
    'pokemon_wild_encounter',
    'pokemon_apply_status',
    'pokemon_vore_track',
]);

function registerFunctionTools() {
    try {
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();
        if (!registerFunctionTool || !unregisterFunctionTool) {
            console.debug('[pokemon-dice-roller] Function tools not supported');
            return;
        }

        for (const name of ALL_TOOL_NAMES) {
            try { unregisterFunctionTool(name); } catch { /* ok */ }
        }

        const settings = getSettings();
        if (!settings.functionTool) return;

        // ── 1. Roll Dice (enhanced with modifier support) ──
        registerFunctionTool({
            name: 'pokemon_roll_dice',
            displayName: 'Pokémon RPG Dice Roll',
            description: 'Roll dice for the Pokémon RPG. ALWAYS call this tool when a dice roll, check, or contest is needed. Never simulate or invent dice results.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    who:      { type: 'string',  description: 'Name of the character or Pokémon rolling.' },
                    formula:  { type: 'string',  description: 'Dice formula (e.g. 1d20, 2d6+3).' },
                    dc:       { type: 'number',  description: 'Difficulty Class (5=routine, 10=standard, 15=difficult, 18=very difficult, 20=extreme).' },
                    reason:   { type: 'string',  description: 'Why the roll is happening (e.g. Vore Attempt, Escape Check).' },
                    modifier: { type: 'number',  description: 'Situational modifier added to total (+2 type advantage, -3 status penalty, etc.).' },
                },
                required: ['formula'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const formula = String(args.formula || args.dice || '1d20').trim();
                const dc = args.dc != null ? parseInt(args.dc, 10) : null;
                const who = String(args.who || '').trim();
                const reason = String(args.reason || '').trim();
                const modifier = args.modifier != null ? (parseInt(args.modifier, 10) || 0) : 0;

                const roll = await performRoll(formula, { quiet: true });
                if (!roll.total) return 'Dice roll failed. Formula may be invalid.';

                const rawTotal = parseInt(roll.total, 10);
                const effectiveTotal = rawTotal + modifier;
                const context = SillyTavern.getContext();
                const roller = who || context.name1;
                const reasonText = reason ? ` for "${reason}"` : '';
                const detail = settings.showDetails && roll.rolls.length > 1 ? ` [${roll.rolls.join(', ')}]` : '';
                const modStr = modifier !== 0 ? ` ${modifier > 0 ? '+' : ''}${modifier} = **${effectiveTotal}**` : '';

                let message = `🎲 ${roller} rolls ${formula}${reasonText}. Result: **${rawTotal}**${detail}${modStr}`;
                if (dc != null) {
                    const res = resolveVsDC(effectiveTotal, dc);
                    message += ` vs DC ${dc}: ${res.emoji} **${res.label}** — ${res.desc}`;
                }
                context.sendSystemMessage('generic', message, { isSmallSys: true });

                let result = `${roller} rolls ${formula}${reasonText}. Raw: ${rawTotal}`;
                if (modifier !== 0) result += `, modifier: ${modifier > 0 ? '+' : ''}${modifier}, total: ${effectiveTotal}`;
                else result += `, total: ${rawTotal}`;
                result += ` (individual: ${roll.rolls.join(', ')})`;
                if (dc != null) {
                    const res = resolveVsDC(effectiveTotal, dc);
                    result += `. vs DC ${dc}: ${res.label} — ${res.desc}`;
                }
                return result;
            },
            formatMessage: () => '',
        });

        // ── 2. Checkpoint ─────────────────────────
        registerFunctionTool({
            name: 'pokemon_checkpoint',
            displayName: 'Pokémon RPG Checkpoint',
            description: 'Present a CHECKPOINT to the player when an uncertain action requires a dice roll. Shows interactive Roll / Auto-Resolve / Submit buttons. Call this instead of writing checkpoint text in your message.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    action:    { type: 'string', description: 'What the roll is for (e.g. Vore Attempt, Escape Check, Attack Roll).' },
                    dc:        { type: 'number', description: 'Difficulty Class for this check.' },
                    formula:   { type: 'string', description: 'Dice formula (default: 1d20).' },
                    who:       { type: 'string', description: 'Who needs to roll.' },
                    modifiers: { type: 'string', description: 'Description of active modifiers (e.g. "+2 type advantage, -2 paralyzed").' },
                },
                required: ['action', 'dc'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const action = String(args.action || 'Action').trim();
                const dc = args.dc != null ? parseInt(args.dc, 10) : 10;
                const formula = String(args.formula || '1d20').trim();
                const who = String(args.who || '').trim();
                const mods = String(args.modifiers || '').trim();

                const whoText = who ? `\n**Who:** ${who}` : '';
                const modText = mods ? `\n**Modifiers:** ${mods}` : '';
                const message = `**[CHECKPOINT: ROLL REQUIRED]**\n**${action} | DC: ${dc}**${whoText}${modText}\n\n[ROLL ${formula}] | [AUTO-RESOLVE] | [SUBMIT]`;

                const context = SillyTavern.getContext();
                context.sendSystemMessage('generic', message, { isSmallSys: false });
                setTimeout(() => processExistingMessages(), 300);

                return `Checkpoint presented: "${action}" DC ${dc} (${formula}). Waiting for player choice.`;
            },
            formatMessage: () => '',
        });

        // ── 3. Battle Start ───────────────────────
        registerFunctionTool({
            name: 'pokemon_battle_start',
            displayName: 'Pokémon Battle Start',
            description: 'Initialize and display a battle interface with HP/STM tracking. Call when a battle begins.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    battle_type:   { type: 'string', description: 'WILD ENCOUNTER, TRAINER BATTLE, GYM BATTLE, or RIVAL BATTLE.' },
                    opponent_name: { type: 'string', description: 'Opponent trainer name (omit for wild encounters).' },
                    allies: {
                        type: 'array',
                        description: 'Player Pokémon team.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Nickname.' }, species: { type: 'string', description: 'Species.' },
                                level: { type: 'number' }, hp: { type: 'number' }, maxHp: { type: 'number' },
                                stm: { type: 'number' }, maxStm: { type: 'number' },
                                types: { type: 'array', items: { type: 'string' }, description: 'Types (e.g. ["Fire","Flying"]).' },
                            },
                        },
                    },
                    enemies: {
                        type: 'array',
                        description: 'Opponent Pokémon.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' }, species: { type: 'string' },
                                level: { type: 'number' }, hp: { type: 'number' }, maxHp: { type: 'number' },
                                stm: { type: 'number' }, maxStm: { type: 'number' },
                                types: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                },
                required: ['battle_type', 'allies', 'enemies'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const btype = String(args.battle_type || 'BATTLE').toUpperCase().trim();
                const opponent = String(args.opponent_name || '').trim();
                const makeCombatant = (a) => ({
                    name: String(a.name || a.species || 'Unknown'),
                    species: String(a.species || a.name || 'Unknown'),
                    level: parseInt(a.level, 10) || 5,
                    hp: parseInt(a.hp ?? a.maxHp, 10) || 30,
                    maxHp: parseInt(a.maxHp ?? a.hp, 10) || 30,
                    stm: parseInt(a.stm ?? a.maxStm, 10) || 20,
                    maxStm: parseInt(a.maxStm ?? a.stm, 10) || 20,
                    types: Array.isArray(a.types) ? a.types : [],
                    status: [],
                });

                battleState.active = true;
                battleState.type = btype;
                battleState.opponent = opponent;
                battleState.allies = (args.allies || []).map(makeCombatant);
                battleState.enemies = (args.enemies || []).map(makeCombatant);
                battleState.vore = [];

                const context = SillyTavern.getContext();
                context.sendSystemMessage('generic', formatBattleState(), { isSmallSys: false });

                return `Battle started: ${btype}${opponent ? ' vs ' + opponent : ''}. Allies: ${battleState.allies.map(formatCombatant).join('; ')}. Enemies: ${battleState.enemies.map(formatCombatant).join('; ')}.`;
            },
            formatMessage: () => '',
        });

        // ── 4. Battle Update ──────────────────────
        registerFunctionTool({
            name: 'pokemon_battle_update',
            displayName: 'Pokémon Battle Update',
            description: 'Update a combatant\'s HP, STM, or status during battle. Call after each action resolves to keep the tracker accurate.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    target:        { type: 'string',  description: 'Name or species of the combatant to update.' },
                    hp_change:     { type: 'number',  description: 'HP change (negative = damage, positive = healing).' },
                    stm_change:    { type: 'number',  description: 'STM change (negative = cost, positive = recovery).' },
                    set_hp:        { type: 'number',  description: 'Set HP to exact value (overrides hp_change).' },
                    set_stm:       { type: 'number',  description: 'Set STM to exact value (overrides stm_change).' },
                    add_status:    { type: 'string',  description: 'Status to add: PAR, BRN, FRZ, PSN, SLP, CNF, INF, VORE, STUF.' },
                    remove_status: { type: 'string',  description: 'Status to remove.' },
                    fainted:       { type: 'boolean', description: 'Mark combatant as fainted (sets HP to 0).' },
                },
                required: ['target'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const targetName = String(args.target || '').trim();
                if (!battleState.active) return 'No active battle. Call pokemon_battle_start first.';

                const c = findCombatant(targetName);
                if (!c) return `Combatant "${targetName}" not found. Known: ${[...battleState.allies, ...battleState.enemies].map(x => x.name).join(', ')}`;

                if (args.set_hp != null) c.hp = Math.max(0, Math.min(parseInt(args.set_hp, 10), c.maxHp));
                else if (args.hp_change != null) c.hp = Math.max(0, Math.min(c.hp + parseInt(args.hp_change, 10), c.maxHp));

                if (args.set_stm != null) c.stm = Math.max(0, Math.min(parseInt(args.set_stm, 10), c.maxStm));
                else if (args.stm_change != null) c.stm = Math.max(0, Math.min(c.stm + parseInt(args.stm_change, 10), c.maxStm));

                if (args.add_status) {
                    const s = String(args.add_status).toUpperCase().trim();
                    if (!c.status.includes(s)) c.status.push(s);
                }
                if (args.remove_status) {
                    const s = String(args.remove_status).toUpperCase().trim();
                    c.status = c.status.filter(st => st !== s);
                }
                if (args.fainted) {
                    c.hp = 0;
                    if (!c.status.includes('FNT')) c.status.push('FNT');
                }

                let note = '';
                if (args.hp_change != null && args.hp_change < 0) note += `💥 ${c.name} took ${Math.abs(parseInt(args.hp_change, 10))} damage! `;
                if (args.hp_change != null && args.hp_change > 0) note += `💚 ${c.name} healed ${parseInt(args.hp_change, 10)} HP! `;
                if (args.stm_change != null && args.stm_change < 0) note += `⚡ ${c.name} spent ${Math.abs(parseInt(args.stm_change, 10))} STM. `;
                if (args.stm_change != null && args.stm_change > 0) note += `🔋 ${c.name} recovered ${parseInt(args.stm_change, 10)} STM. `;
                if (args.fainted) note += `💀 ${c.name} fainted! `;

                const context = SillyTavern.getContext();
                const message = (note ? note.trim() + '\n\n' : '') + formatBattleState();
                context.sendSystemMessage('generic', message, { isSmallSys: false });

                return formatCombatant(c);
            },
            formatMessage: () => '',
        });

        // ── 5. Type Effectiveness Check ───────────
        registerFunctionTool({
            name: 'pokemon_type_check',
            displayName: 'Pokémon Type Check',
            description: 'Check type effectiveness of an attacking type against defending type(s). Returns damage multiplier. Use before narrating attack outcomes.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    attack_type:    { type: 'string', description: 'Attacking move type (Fire, Water, Psychic, etc.).' },
                    defender_types: { type: 'array', items: { type: 'string' }, description: 'Defending Pokémon type(s).' },
                },
                required: ['attack_type', 'defender_types'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const atk = String(args.attack_type || '').trim();
                const def = Array.isArray(args.defender_types)
                    ? args.defender_types.map(t => String(t).trim())
                    : [String(args.defender_types || '').trim()];

                const eff = getTypeEffectiveness(atk, def);
                return `${atk} vs ${def.join('/')}: ${eff.multiplier}x — ${eff.label}`;
            },
            formatMessage: () => '',
        });

        // ── 6. Wild Encounter ─────────────────────
        registerFunctionTool({
            name: 'pokemon_wild_encounter',
            displayName: 'Pokémon Wild Encounter',
            description: 'Announce a wild Pokémon encounter with species, level, behavior, and stats. Use when the player enters tall grass or triggers an encounter.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    species:  { type: 'string', description: 'Pokémon species name.' },
                    level:    { type: 'number', description: 'Level.' },
                    behavior: { type: 'string', description: 'Behavior: Curious, Hungry, Territorial, In Heat, or Stuffed.' },
                    hp:       { type: 'number', description: 'Max HP.' },
                    stm:      { type: 'number', description: 'Max STM.' },
                    types:    { type: 'array', items: { type: 'string' }, description: 'Type(s).' },
                    gender:   { type: 'string', description: 'Gender.' },
                },
                required: ['species', 'level'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const species = String(args.species || 'MissingNo').trim();
                const level = parseInt(args.level, 10) || 5;
                const behavior = String(args.behavior || 'Curious').trim();
                const hp = parseInt(args.hp, 10) || 30;
                const stm = parseInt(args.stm, 10) || 20;
                const types = Array.isArray(args.types) ? args.types : [];
                const gender = args.gender ? String(args.gender).trim() : '';

                const typeStr = types.length ? ` [${types.join('/')}]` : '';
                const genderStr = gender ? ` (${gender})` : '';
                const message = `🌿 **A wild ${species} appeared!**${genderStr}\nLv.${level}${typeStr} — Behavior: **${behavior}**\nHP: ${hp}/${hp} | STM: ${stm}/${stm}`;

                const context = SillyTavern.getContext();
                context.sendSystemMessage('generic', message, { isSmallSys: false });

                return `Wild ${species}${genderStr} Lv.${level} appeared. Types: ${types.join('/') || 'unknown'}. Behavior: ${behavior}. HP: ${hp}/${hp}, STM: ${stm}/${stm}.`;
            },
            formatMessage: () => '',
        });

        // ── 7. Apply / Remove Status ──────────────
        registerFunctionTool({
            name: 'pokemon_apply_status',
            displayName: 'Pokémon Apply Status',
            description: 'Apply or remove a status condition on a combatant. Updates battle tracker if active.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    target: { type: 'string', description: 'Name of the combatant.' },
                    status: { type: 'string', description: 'Status code: PAR, BRN, FRZ, PSN, SLP, CNF, INF, VORE, STUF.' },
                    action: { type: 'string', description: '"add" or "remove". Default: "add".' },
                    detail: { type: 'string', description: 'Flavor text for the status change.' },
                },
                required: ['target', 'status'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const targetName = String(args.target || '').trim();
                const status = String(args.status || '').toUpperCase().trim();
                const act = String(args.action || 'add').toLowerCase().trim();
                const detail = String(args.detail || '').trim();

                const c = findCombatant(targetName);
                const context = SillyTavern.getContext();

                if (act === 'remove') {
                    if (c) c.status = c.status.filter(s => s !== status);
                    const msg = `✨ ${targetName}'s ${status} was cured!${detail ? ' ' + detail : ''}`;
                    context.sendSystemMessage('generic', msg, { isSmallSys: true });
                    return msg;
                }

                if (c && !c.status.includes(status)) c.status.push(status);
                const msg = `⚠️ ${targetName} is now **${status}**!${detail ? ' ' + detail : ''}`;
                context.sendSystemMessage('generic', msg, { isSmallSys: true });
                return msg;
            },
            formatMessage: () => '',
        });

        // ── 8. Vore Tracker ───────────────────────
        registerFunctionTool({
            name: 'pokemon_vore_track',
            displayName: 'Pokémon Vore Tracker',
            description: 'Track vore progression: swallowing, digesting, digested, released, or escaped. Updates prey status in battle. Call when vore begins, progresses, or ends.',
            parameters: Object.freeze({
                type: 'object',
                properties: {
                    pred:   { type: 'string',  description: 'Name of the predator.' },
                    prey:   { type: 'string',  description: 'Name of the prey.' },
                    phase:  { type: 'string',  description: 'Phase: swallowing, digesting, digested, released, escaped.' },
                    fatal:  { type: 'boolean', description: 'Whether this is fatal vore.' },
                    detail: { type: 'string',  description: 'Extra detail about the vore state.' },
                },
                required: ['pred', 'prey', 'phase'],
            }),
            action: async (args) => {
                args = sanitizeToolArgs(args);
                const pred = String(args.pred || '').trim();
                const prey = String(args.prey || '').trim();
                const phase = String(args.phase || 'swallowing').toLowerCase().trim();
                const fatal = !!args.fatal;
                const detail = String(args.detail || '').trim();

                // Update vore tracking
                const existing = battleState.vore.find(v => v.pred === pred && v.prey === prey);
                if (existing) {
                    existing.phase = phase;
                    existing.fatal = fatal;
                    existing.turns++;
                } else {
                    battleState.vore.push({ pred, prey, phase, fatal, turns: 1 });
                }

                // Update prey status in battle state
                const preyC = findCombatant(prey);
                if (preyC) {
                    if (phase === 'released' || phase === 'escaped') {
                        preyC.status = preyC.status.filter(s => s !== 'VORE');
                    } else if (!preyC.status.includes('VORE')) {
                        preyC.status.push('VORE');
                    }
                    if (phase === 'digested' && fatal) {
                        preyC.hp = 0;
                        if (!preyC.status.includes('FNT')) preyC.status.push('FNT');
                    }
                }

                const emojis = { swallowing: '👄', digesting: '🫃', digested: '💀', released: '✨', escaped: '🏃' };
                const emoji = emojis[phase] || '❓';
                const fatalStr = fatal ? ' ☠️ FATAL' : '';
                const detailStr = detail ? `\n${detail}` : '';
                const msg = `${emoji} **VORE:** ${pred} → ${prey} — **${phase.toUpperCase()}**${fatalStr}${detailStr}`;

                const context = SillyTavern.getContext();
                context.sendSystemMessage('generic', msg, { isSmallSys: true });

                let result = `Vore: ${pred} ${phase} ${prey}${fatal ? ' (fatal)' : ''}.`;
                if (phase === 'digested' && fatal) result += ` ${prey} fully digested.`;
                if (phase === 'escaped') result += ` ${prey} escaped from ${pred}.`;
                if (phase === 'released') result += ` ${pred} released ${prey}.`;
                const active = battleState.vore.filter(v => !['digested', 'released', 'escaped'].includes(v.phase));
                if (active.length) result += ` Active: ${active.map(v => `${v.pred}→${v.prey}(${v.phase}, ${v.turns}t)`).join(', ')}.`;
                return result;
            },
            formatMessage: () => '',
        });

        console.log('[pokemon-dice-roller] All function tools registered');
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
