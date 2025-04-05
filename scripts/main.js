// PF2e AI Combat Assistant Module
// Version: 2.7.4 (PC Bonus/Spec Fix, Stance Desc, NPC Mod Fix)
// ====================================================================

// Log module loading
console.log("PF2e AI Combat Assistant | Module Loading (v1.0)");

// --- Constants ---

const MODULE_ID = 'pf2e-ai-combat-assistant'; // Unique identifier for the module

// Flags used to store data on actors and combat
const FLAGS = {
    DESIGNATIONS: 'designations',           // Stores friendly/enemy status (on Combat)
    TURN_STATE: 'turnState',               // Stores AI turn state (actions, MAP, history, manualNotes) (on Actor)
    IS_PROCESSING: 'isProcessing',         // Is AI currently handling turn? (on Actor)
    CACHED_STRIKES: 'cachedStrikes',       // Detailed strike data gathered at turn start (on Actor)
    OFFER_ID: 'offerId',                   // Unique ID for AI turn offer messages (on ChatMessage)
    DESIGNATION_MSG_ID: 'designationMsgId',    // Unique ID for the designation setup message (on ChatMessage)
    TEMP_THINKING: 'pf2eArenaAi_tempThinking', // Temporary flag for deleting "Thinking..." messages (on ChatMessage)
    MANUAL_NOTES_INPUT_ID: 'manualNotesInputId', // Unique ID for manual input field (on ChatMessage)
    PERMANENT_NOTES: 'permanentNotes',         // Stores permanent player notes for the AI (on Actor)
};

// --- Hooks ---

// Hook to scroll chat log to the bottom on new messages
Hooks.on('renderChatMessage', (message, html, data) => {
    // Check if the chat log exists and is visible
    const chatLog = ui.chat?.element?.find("#chat-log")?.[0];
    if (chatLog) {
        // Check if the user isn't scrolled up significantly
        const userScrolledUp = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight > 100;
        if (!userScrolledUp) {
             // Use a small timeout to ensure the message is fully rendered
             setTimeout(() => {
                chatLog.scrollTop = chatLog.scrollHeight;
             }, 50); // 50ms delay
        }
    }
});

// --- Utility Functions ---

/**
 * Extracts a numeric range value (in feet) from spell or strike/weapon data for sorting and checks.
 * Prioritizes direct range values, then traits (range-increment, reach), then area dimensions, then defaults.
 * @param {object} abilityData - Spell, Strike, or Weapon object (either ItemPF2e or formatted data).
 * @param {string} [context='unknown'] - Optional context for logging (e.g., 'gatherGameState', 'promptCrafting').
 * @returns {number} Numeric range in feet (9999 for unlimited, 5 for touch/melee, 0 for self/unknown, or parsed value).
 */
function getNumericRange(abilityData, context = 'unknown') {
    if (!abilityData) return 0;
    const itemName = abilityData.name || abilityData.label || 'Unknown Item';
    const itemType = abilityData.type || abilityData.item?.type || abilityData.weapon?.type || 'unknown';
    const weapon = abilityData.weapon || abilityData.item; // Handle StrikeData or ItemPF2e
    const traits = weapon?.system?.traits?.value || abilityData?.traits || []; // Get traits from weapon/item or direct data

    // --- Standard Range Property Checks (Priority 1) ---
    let directRangeValue = abilityData.system?.range?.value ?? abilityData.range ?? weapon?.system?.range?.value;
    let isExplicitlySelf = false;
    let isExplicitlyTouch = false;

    if (directRangeValue !== null && directRangeValue !== undefined && directRangeValue !== "-") {
        const parsedRange = parseInt(directRangeValue, 10);
        if (!isNaN(parsedRange)) {
            // console.debug(`AI getNumericRange (${context}): Found direct numeric range ${parsedRange} on ${itemName}`); // DEBUG
            return parsedRange; // Direct numeric range found
        }
        const rangeStr = String(directRangeValue).toLowerCase();
        if (rangeStr === 'touch') { isExplicitlyTouch = true; /* Don't return yet */ }
        else if (rangeStr === 'self') { isExplicitlySelf = true; /* Don't return yet */ }
        else if (rangeStr.includes('unlimited') || rangeStr.includes('planetary')) { return 9999; }
        else {
            const match = rangeStr.match(/(\d+)\s*(?:feet|ft)/);
            if (match?.[1]) { return parseInt(match[1], 10); }
        }
    }

    // --- Trait-Based Range/Reach Checks (Priority 2) ---
    if (Array.isArray(traits)) {
        // Check for range-increment-X first
        const rangeIncrementTrait = traits.find(t => typeof t === 'string' && t.startsWith("range-increment-"));
        if (rangeIncrementTrait) {
            const rangeNum = parseInt(rangeIncrementTrait.split('-')[2], 10); // "range-increment-60" -> 60
            if (!isNaN(rangeNum)) {
                // console.debug(`AI getNumericRange (${context}): Parsed '${rangeIncrementTrait}' trait as ${rangeNum}ft on ${itemName}`); // DEBUG
                return rangeNum; // Use range increment value
            }
        }

        // Check for reach-X (typically melee)
        const reachTrait = traits.find(t => typeof t === 'string' && t.startsWith("reach-"));
        if (reachTrait) {
            const reachNum = parseInt(reachTrait.split('-')[1], 10); // "reach-15" -> 15
            if (!isNaN(reachNum)) {
                // console.debug(`AI getNumericRange (${context}): Parsed '${reachTrait}' trait as ${reachNum}ft on ${itemName}`); // DEBUG
                return reachNum; // Use reach value
            }
            // console.warn(`AI getNumericRange (${context}): Found reach trait '${reachTrait}' but failed to parse number on ${itemName}. Defaulting reach to 10.`); // DEBUG
            return 10; // Fallback for unparsed reach trait
        }
    }

    // --- Area Dimension Check (Priority 3 - for Self/Touch or No Range/Trait Spells) ---
    if (itemType === 'spell' && (isExplicitlySelf || isExplicitlyTouch || directRangeValue === null || directRangeValue === undefined || directRangeValue === "-" || directRangeValue === "")) {
        const area = abilityData.system?.area;
        if (area && area.value && area.type) {
            const areaValue = parseInt(area.value, 10);
            if (!isNaN(areaValue) && areaValue > 0) { return areaValue; }
        }
    }
    // Return explicit touch/self defaults if no area/traits applied
    if (isExplicitlyTouch) return 5;
    if (isExplicitlySelf) return 0;

    // --- Final Defaults (Priority 4) ---
    // Is it explicitly melee from system data? (e.g., weapon.isMelee)
    if (weapon?.system?.isMelee) {
        // console.debug(`AI getNumericRange (${context}): Defaulting to 5ft for explicitly melee item ${itemName} (no specific reach trait found/parsed).`); // DEBUG
        return 5;
    }
    // General fallback for weapon/strike types if no range found
    if (itemType === 'weapon' || itemType === 'strike' || itemType === 'melee') {
        // console.debug(`AI getNumericRange (${context}): Defaulting to 5ft for weapon/strike ${itemName} with no specific range/reach found.`); // DEBUG
        return 5;
    }

    // Absolute default for anything else
    // console.debug(`AI getNumericRange (${context}): Defaulting to 0 for ability ${itemName} of type ${itemType}`); // DEBUG
    return 0;
}


/**
 * Cleans up and summarizes HTML description text for prompts.
 * Removes most HTML tags, converts basic formatting to newlines/separators,
 * handles @Localize, strips condition UUIDs, and extracts text from common Foundry/PF2e link formats.
 * Separator logic removed - handled in createAbilityListString now.
 * @param {string|null} descriptionHTML - The HTML content to clean.
 * @returns {string} A cleaned-up plain text summary.
 */
function summarizeAbilityDetails(descriptionHTML) {
    if (!descriptionHTML || typeof descriptionHTML !== 'string') {
        return '';
    }

    // Basic cleaning and formatting for prompt injection
    let cleanedDescription = descriptionHTML
        .replace(/<br\s*\/?>/gi, '\n') // Convert <br> to newlines
        .replace(/<\/?p>/gi, '\n') // Convert paragraphs to newlines (extra newlines will be collapsed later)
        .replace(/<hr\s*\/?>/gi, '\n---\n') // Convert <hr> to a separator
        .replace(/<\/?(?:strong|b|em|i|u)>/gi, '') // Remove basic formatting tags (bold, italic, etc.)
        .replace(/<a [^>]+>([^<]+)<\/a>/gi, '$1') // Keep only the text content of links
        // Remove most UUID links, keeping only the text label
        .replace(/@UUID\[[^\]]+\]\{([^}]+)\}/gi, '$1')
        .replace(/@Check\[[^\]]+\]\{([^}]+)\}/gi, '$1') // Extract text from @Check links
        .replace(/@Damage\[([^\]]+)\]/gi, '$1'); // Extract damage formula text from @Damage

    // Handle @Localize tags
    cleanedDescription = cleanedDescription.replace(/(@Localize\[([^\]]+)\])/g, (match, fullMatch, key) => {
        if (key) {
            const localizedText = game.i18n.localize(key);
            // Replace the tag with the localized text directly
            return localizedText !== key ? localizedText : fullMatch;
        }
        return fullMatch;
    });

    // --- REMOVED Separator logic ---
    // It was too fragile. We will parse Req/Trig/Effect in createAbilityListString.

    // Strip specific Condition UUIDs after general UUID handling and localization
    cleanedDescription = cleanedDescription.replace(/@UUID\[Compendium\.pf2e\.conditionitems\.Item\.[^\]]+\]\{([^}]+)\}/gi, '$1');

    // Final cleanup
    cleanedDescription = cleanedDescription
        .replace(/\[\[\/gmr ([^#]+)#([^\]]+)\]\]\{([^}]+)\}/gi, '$1 ($3)') // Handle GMR links cleanly
        .replace(/<[^>]*>/g, ' ') // Remove all remaining HTML tags
        .replace(/ {2,}/g, ' ') // Collapse multiple spaces to a single space
        .replace(/\n\s*\n/g, '\n') // Remove empty lines resulting from tag removal
        .replace(/\n /g, '\n') // Remove leading spaces on new lines
        .trim(); // Remove leading/trailing whitespace

    return cleanedDescription;
}

/**
 * Decides if a long description should be excluded from the prompt,
 * assuming it's likely flavor text rather than critical mechanics.
 * Uses length thresholds and keyword heuristics.
 * **This should NOT be used for Spells or Conditions/Effects.**
 * @param {string|null} fullDescription - The cleaned description text.
 * @param {string} abilityName - The name of the ability/feat (for logging).
 * @param {number} [absoluteMaxLength=1200] - Absolute max length threshold.
 * @param {number} [heuristicMaxLength=400] - Threshold for keyword heuristic check.
 * @returns {boolean} True if the description should be excluded.
 */
function shouldExcludeDescription(fullDescription, abilityName, absoluteMaxLength = 1200, heuristicMaxLength = 400) {
    if (!fullDescription) {
        return false; // Don't exclude if there's no description
    }

    // Exclude if simply too long
    if (fullDescription.length > absoluteMaxLength) {
        // console.log(`AI Exclude Desc (Too Long: ${fullDescription.length}): ${abilityName}`); // DEBUG
        return true;
    }

    // Heuristic: If it's moderately long and seems mostly flavor-oriented, exclude.
    if (fullDescription.length > heuristicMaxLength) {
        const lowerDesc = fullDescription.toLowerCase();
        // Keywords suggesting flavor/lore/roleplaying aspects
        const flavorKeywords = [
            'choose a deity', 'anathema', 'edicts', 'sanctification', 'roleplaying',
            'atone ritual', 'skill training', 'alignment', 'multiclass dedication',
            'archetype', 'background', 'story', 'appearance', 'personality'
        ];
        // Keywords suggesting mechanical/combat relevance
        const combatKeywords = [
            'make a strike', 'cast a spell', 'reaction', 'trigger', 'frequency', 'stance',
            'condition', 'save dc', 'hit points', 'heal', 'round',
            'minute', 'action', 'area', 'range', 'feet', 'stride', 'step',
            'attack', 'damage', 'flat check', 'circumstance bonus', 'status bonus',
            'item bonus', 'penalty', 'damage', 'restore'
        ];

        const flavorCount = flavorKeywords.reduce((count, keyword) => count + (lowerDesc.includes(keyword) ? 1 : 0), 0);
        const combatCount = combatKeywords.reduce((count, keyword) => count + (lowerDesc.includes(keyword) ? 1 : 0), 0);

        // If it contains multiple flavor keywords and very few (or no) combat keywords, likely exclude.
        if (flavorCount >= 2 && combatCount <= 1) {
            // console.log(`AI Exclude Desc (Flavor>Combat): ${abilityName} (Flavor: ${flavorCount}, Combat: ${combatCount})`); // DEBUG
            return true;
        }
    }

    return false; // Otherwise, include the description
}

/**
 * Generates HTML for the standard PF2e action cost icon (A, D, T, R, F, variable, ?).
 * @param {number|string|null} parsedCost - The parsed action cost (e.g., 1, 2, 3, 'R', 'F', '1 to 3', null).
 * @param {string} [description=''] - Optional description text to help identify reactions based on triggers.
 * @returns {string} HTML span element for the action glyph.
 */
function getActionIconHTML(parsedCost, description = '') {
    const descLower = description?.toLowerCase() || '';

    // Determine if it's likely a Reaction (cost might be null/1 but description indicates Trigger)
    const isLikelyReaction = (parsedCost === 'R') ||
        ((parsedCost === null || parsedCost === 1) && (descLower.includes('reaction') || descLower.includes('trigger:')));

    if (isLikelyReaction) {
        return '<span class="action-glyph" title="Reaction">R</span>';
    }
    if (parsedCost === 'F' || parsedCost === 0) {
        return '<span class="action-glyph" title="Free Action">F</span>';
    }

    // Handle numeric costs directly
    if (Number.isInteger(parsedCost) && parsedCost >= 1 && parsedCost <= 3) {
        switch (parsedCost) {
            case 1: return '<span class="action-glyph" title="Single Action">A</span>';
            case 2: return '<span class="action-glyph" title="Two Actions">D</span>';
            case 3: return '<span class="action-glyph" title="Three Actions">T</span>';
        }
    }

    // Handle variable costs like "1 to 3"
    if (typeof parsedCost === 'string' && parsedCost.includes(' to ')) {
        // Use the string directly as the display, more informative than a single glyph
        return `<span title="${parsedCost} Actions">${parsedCost}</span>`;
    }

    // Fallback for unknown or unusual costs
    return parsedCost ? `<span title="${parsedCost} Actions">${parsedCost}</span>` : '<span title="Unknown Cost">?</span>';
}


/**
 * Parses the action cost from an item's fields or its description HTML.
 * Standardizes the cost representation. Now checks actionType.value directly.
 * @param {string|number|null} timeValue - The value from `item.system.time.value`.
 * @param {string|number|null} actionsValue - The value from `item.system.actions.value`.
 * @param {string|null} [descriptionHTML=null] - The item's description HTML as a fallback.
 * @param {string|null} [actionTypeValue=null] - The value from `item.system.actionType.value` (optional).
 * @returns {number|string|null} The parsed cost: 1, 2, 3, 'R', 'F', '1 to 3', or null if unparseable.
 */
function parseActionCostValue(timeValue, actionsValue, descriptionHTML = null, actionTypeValue = null) {
    // Helper function to check a string value for standard cost notations
    const checkStringValue = (value) => {
        if (value === null || value === undefined) return null;
        const lowerValue = String(value).toLowerCase().trim();
        if (lowerValue === 'reaction') return 'R';
        if (lowerValue === 'free') return 'F';
        const actionMatch = lowerValue.match(/^(?:(\d+)|one|two|three)\s*action[s]?$/);
        if (actionMatch) { if (actionMatch[1]) return parseInt(actionMatch[1], 10); if (lowerValue.startsWith('one')) return 1; if (lowerValue.startsWith('two')) return 2; if (lowerValue.startsWith('three')) return 3; }
        const rangeMatch = lowerValue.match(/^(\d+)\s+to\s+(\d+)(?:\s*action[s]?)?$/);
        if (rangeMatch?.[1] && rangeMatch?.[2]) { const min = parseInt(rangeMatch[1], 10); const max = parseInt(rangeMatch[2], 10); if (!isNaN(min) && !isNaN(max) && min >= 1 && max >= min && max <= 3) return `${min} to ${max}`; }
        return null;
    };

    // --- Priority Checks ---
    // 1. Direct actionType check (Added)
    if (actionTypeValue === 'free') return 'F';
    if (actionTypeValue === 'reaction') return 'R';

    // 2. system.time.value and system.actions.value (String format)
    const costFromTimeStr = checkStringValue(timeValue); if (costFromTimeStr !== null) return costFromTimeStr;
    const costFromActionsStr = checkStringValue(actionsValue); if (costFromActionsStr !== null) return costFromActionsStr;

    // 3. system.time.value and system.actions.value (Numeric format)
    const timeNum = parseInt(String(timeValue), 10); if (!isNaN(timeNum) && String(timeNum) === String(timeValue).trim() && timeNum >= 0 && timeNum <= 3) return timeNum;
    const actionsNum = parseInt(String(actionsValue), 10); if (!isNaN(actionsNum) && String(actionsNum) === String(actionsValue).trim() && actionsNum >= 0 && actionsNum <= 3) return actionsNum;

    // 4. Description HTML parsing (Fallback)
    if (descriptionHTML) {
        // Standard activation glyphs
        const activationMatchGlyph = descriptionHTML.match(/<strong>Activate<\/strong>\s*<span[^>]+action-glyph[^>]+>([ADTRF])<\/span>/i);
        if (activationMatchGlyph?.[1]) { const glyph = activationMatchGlyph[1].toUpperCase(); if (glyph === 'A') return 1; if (glyph === 'D') return 2; if (glyph === 'T') return 3; if (glyph === 'R') return 'R'; if (glyph === 'F') return 'F'; }
        // Text activation costs
        const textActivationMatch = descriptionHTML.match(/<strong>Activate<\/strong>\s*(\d+|one|two|three)\s*action/i);
        if (textActivationMatch?.[1]) { const costText = textActivationMatch[1].toLowerCase(); if (costText === '1' || costText === 'one') return 1; if (costText === '2' || costText === 'two') return 2; if (costText === '3' || costText === 'three') return 3; }
        // Text reaction/free action
        const textActivationOtherMatch = descriptionHTML.match(/<strong>Activate<\/strong>\s*(Reaction|Free Action)/i);
        if (textActivationOtherMatch?.[1]) { const costText = textActivationOtherMatch[1].toLowerCase(); if (costText === 'reaction') return 'R'; if (costText === 'free action') return 'F'; }
        // Interact activation
        const interactActivationMatch = descriptionHTML.match(/<strong>Activate<\/strong>(?:\s*<span[^>]*>[^<]+<\/span>)?\s*\(?(Interact)\)?/i);
        if (interactActivationMatch) return 1;
        // Frequency/Trigger text suggesting Reaction/Free
        const descLower = descriptionHTML.toLowerCase();
        if (descLower.includes('<strong>frequency</strong>') && descLower.includes('<strong>trigger</strong>')) return 'R';
        // Check for "free action" text associated with frequency for NPC blocks etc.
        if (descLower.includes('<strong>frequency</strong>') && (descLower.includes('free action') || descLower.includes('no action'))) return 'F';
    }

    // 5. If actionTypeValue was numeric (e.g., for NPC actions with simple cost) (Added)
    if (actionTypeValue && !isNaN(parseInt(actionTypeValue, 10)) && parseInt(actionTypeValue, 10) >= 1 && parseInt(actionTypeValue, 10) <= 3) {
        return parseInt(actionTypeValue, 10);
    }


    return null; // Cannot parse cost
}


/**
 * Formats a parsed action cost (from parseActionCostValue) into a concise display string for prompts.
 * Example: 1 -> "(1a)", 'R' -> "(R)", "1 to 3" -> "(1-3a)".
 * @param {number|string|null} parsedCost - The standardized cost value.
 * @returns {string} The formatted cost string, e.g., "(1a)", "(R)", "(?)".
 */
function formatParsedCostToDisplay(parsedCost) {
    if (parsedCost === 'F' || parsedCost === 0) return '(F)';
    if (parsedCost === 'R') return '(R)';
    if (parsedCost === 1) return '(1a)';
    if (parsedCost === 2) return '(2a)';
    if (parsedCost === 3) return '(3a)';
    if (typeof parsedCost === 'string' && parsedCost.includes(' to ')) {
        const parts = parsedCost.split(' to ');
        if (parts.length === 2) return `(${parts[0]}-${parts[1]}a)`;
    }
    return '(?)';
}

/**
 * Checks if a spell can likely be cast by the actor based on spell type and available resources.
 * Handles Cantrips, Focus Spells, Prepared, and Spontaneous/Flexible casters.
 * @param {ItemPF2e<SpellPF2e>} spell - The spell item.
 * @param {ActorPF2e} actor - The actor attempting to cast.
 * @returns {boolean} True if the spell seems available to cast, false otherwise.
 */
/**
 * Checks if a specific ability is currently on cooldown for the actor based on AI-managed effects.
 * @param {ActorPF2e} actor - The actor to check.
 * @param {ItemPF2e} ability - The ability (spell, feat, action) item to check.
 * @returns {boolean} True if the ability is on cooldown, false otherwise.
 */
function isAbilityOnCooldown(actor, ability) {
    if (!actor || !ability || !ability.system || !ability.slug) {
        // console.warn("AI isAbilityOnCooldown: Invalid actor or ability provided."); // DEBUG
        return false; // Cannot determine cooldown without valid data
    }

    const frequency = ability.system.frequency;
    // Check if frequency exists, has a 'per' value, and a max value > 0
    if (!frequency || !frequency.per || !(frequency.max > 0)) {
        // If no limited frequency, it cannot be on cooldown via our effect mechanism.
        // console.log(`AI isAbilityOnCooldown: Ability "${ability.name}" has no limited frequency. Not checking AI effect.`); // DEBUG
        return false;
    }

    // Construct the expected slug for the cooldown effect
    const expectedEffectSlug = `pf2e-ai-combat-assistant-cooldown-${ability.slug}-${frequency.per}`;

    // Check actor's current effects for a match
    for (const effect of actor.itemTypes.effect) {
        if (effect.slug === expectedEffectSlug) {
            // Found a matching cooldown effect. Foundry handles expiration, so its presence means it's active.
            // console.log(`AI isAbilityOnCooldown: Found active cooldown effect "${effect.name}" for ability "${ability.name}".`); // DEBUG
            return true;
        }
    }

    // console.log(`AI isAbilityOnCooldown: No active cooldown effect found for ability "${ability.name}".`); // DEBUG
    return false; // No matching active cooldown effect found
}


function isSpellAvailable(spell, actor) {
    if (!spell || !actor || !spell.system || !actor.system) {
        console.warn(`PF2e AI Combat Assistant | Invalid spell or actor object passed to isSpellAvailable.`);
        return false;
    }
    const spellLocationId = spell.system.location?.value;
    if (!spellLocationId && !spell.isCantrip && !spell.isFocusSpell && !spell.isRitual) {
        // Check if it's a spell granted by an item (won't have a location)
        const isItemGranted = actor.items.some(item =>
            (item.type === 'weapon' || item.type === 'equipment' || item.type === 'consumable' || item.type === 'treasure' || item.type === 'feat' || item.type === 'action') && // Added feat/action check
            item.system.description?.value?.includes(spell.uuid)
        );
        if (!isItemGranted) {
            // console.warn(`PF2e AI Combat Assistant | Spell "${spell.name}" has no location value and isn't item-granted, assuming unavailable.`); // DEBUG
            return false;
        }
        // Assume item-granted spells are always "available" if the item exists (actual usage might depend on item charges, activation etc.)
        return true;
    }
    if (spell.isCantrip) {
        return true;
    }
    if (spell.isFocusSpell) {
        const focusPool = actor.system.resources?.focus;
        return focusPool && typeof focusPool.value === 'number' && focusPool.value > 0;
    }
    const spellcastingEntry = actor.spellcasting?.get(spellLocationId);
    if (!spellcastingEntry || !spellcastingEntry.system) {
        // console.warn(`PF2e AI Combat Assistant | Could not find spellcasting entry "${spellLocationId}" for spell "${spell.name}".`); // DEBUG
        return false;
    }
    const spellRank = spell.rank;
    const maxSpellRank = CONFIG.PF2E?.spellLevels ?? 10;
    if (spellcastingEntry.isSpontaneous || spellcastingEntry.isFlexible) {
        for (let rank = spellRank; rank <= maxSpellRank; rank++) {
            const slotKey = `slot${rank}`;
            const slotData = spellcastingEntry.system.slots?.[slotKey];
            if (slotData && typeof slotData.value === 'number' && slotData.value > (slotData.expended ?? 0)) {
                return true;
            }
        }
        return false;
    }
    if (spellcastingEntry.isPrepared) {
        for (let rank = spellRank; rank <= maxSpellRank; rank++) {
            const slotKey = `slot${rank}`;
            const slotData = spellcastingEntry.system.slots?.[slotKey];
            if (!slotData?.prepared) continue;
            const foundPreparedSlot = slotData.prepared.find(preparedSpell => preparedSpell?.id === spell.id && !preparedSpell?.expended);
            if (foundPreparedSlot) {
                return true;
            }
        }
        return false;
    }
    console.warn(`PF2e AI Combat Assistant | Unknown spellcasting entry type for "${spell.name}" in entry "${spellLocationId}". Assuming unavailable.`);
    return false;
}


/**
 * Extracts key details (range, target, save, duration, area, traits) from a spell item.
 * Used internally by formatting helpers.
 * @param {ItemPF2e<SpellPF2e>} spell - The spell item.
 * @returns {object} An object containing extracted details.
 */
function _extractSpellDetails(spell) {
    if (!spell || !spell.system) {
        return { range: null, targets: null, defense: null, duration: null, area: null, traitsString: '' };
    }
    const system = spell.system;
    const range = system.range?.value || null;
    const targets = system.target?.value || null;
    // Corrected savingThrow access
    const defenseSave = system.defense?.save?.statistic || system.savingThrow?.statistic || null;
    const defenseBasic = system.defense?.save?.basic ?? system.savingThrow?.basic ?? false;

    let defenseString = defenseSave;
    if (defenseSave && defenseBasic) { defenseString += " (basic)"; }
    const duration = system.duration?.value || null;
    const areaType = system.area?.type || null;
    const areaValue = system.area?.value || null;
    let areaString = null;
    if (areaType && areaValue) { areaString = `${areaValue}-foot ${areaType}`; if (system.area?.details) areaString += ` (${system.area.details})`; }
    const traits = [...(system.traits?.value || [])];
    const rarity = system.traits?.rarity || 'common';
    if (rarity !== 'common' && !traits.includes(rarity)) { traits.unshift(rarity); }
    const traitsString = traits.length > 0 ? `[${traits.join(', ')}]` : '';
    return { range: range, targets: targets, defense: defenseString, duration: duration, area: areaString, traitsString: traitsString };
}

/**
 * Determines the most reliable action cost, preferring system data unless LLM suggests a combo.
 * @param {object} identifyResult - The result from identifySuggestionTypeAndCost.
 * @param {number|string|null} llmCost - The cost suggested by the LLM response.
 * @returns {number|string} The determined authoritative cost (e.g., 1, 2, 'R', '1 to 3'). Defaults to 1 if completely unparseable.
 */
function determineAuthoritativeCost(identifyResult, llmCost) {
    const { actualActionCost, costSource, isCombo } = identifyResult;

    // **If LLM suggests a combo, trust its cost calculation more.**
    if (isCombo) {
        // Validate the LLM's cost for the combo
        if (llmCost === 'R' || llmCost === 'F') {
            // console.log(`AI | Authoritative Cost: Using LLM cost (${llmCost}) for combo action.`); // DEBUG
            return llmCost;
        }
        const numericLLMCost = parseInt(llmCost, 10);
        if (!isNaN(numericLLMCost) && numericLLMCost >= 1 && numericLLMCost <= 3) {
            // console.log(`AI | Authoritative Cost: Using LLM cost (${numericLLMCost}) for combo action.`); // DEBUG
            return numericLLMCost;
        }
        // Handle variable combo costs if LLM suggests (less likely, but possible)
        if (typeof llmCost === 'string' && llmCost.includes(' to ')) {
            // console.warn(`AI | Authoritative Cost: LLM suggested variable cost (${llmCost}) for combo. This is unusual. Trying to parse.`); // DEBUG
            // Cannot reliably determine combo cost from range, fallback needed
        }

        // console.warn(`AI | Authoritative Cost: LLM suggested invalid cost (${llmCost}) for combo. Falling back to identified main action cost or default 1.`); // DEBUG
        // Fallback for invalid combo cost: use identified cost if available, else default to 1
        if (actualActionCost !== null && typeof actualActionCost !== 'string') { // Check if identified cost is specific
            return actualActionCost;
        } else {
            return 1; // Default combo cost if primary is variable or missing
        }
    }

    // --- NEW Logic: If Item cost is Variable, but LLM gave specific valid cost, trust LLM ---
    if (typeof actualActionCost === 'string' && actualActionCost.includes(' to ')) {
        if (llmCost === 'R' || llmCost === 'F') {
            // This shouldn't happen for variable action spells, but handle defensively
            // console.warn(`AI | Authoritative Cost: Item cost is variable (${actualActionCost}), but LLM suggested ${llmCost}. This is contradictory. Defaulting to 1.`); // DEBUG
            return 1;
        }
        const numericLLMCost = parseInt(llmCost, 10);
        if (!isNaN(numericLLMCost) && numericLLMCost >= 1 && numericLLMCost <= 3) {
            // console.log(`AI | Authoritative Cost: Item cost is variable (${actualActionCost}), using specific LLM cost (${numericLLMCost}).`); // DEBUG
            return numericLLMCost; // Trust the LLM's specific choice
        } else {
            // console.warn(`AI | Authoritative Cost: Item cost is variable (${actualActionCost}), but LLM cost (${llmCost}) is invalid. Defaulting to 1 action from range.`); // DEBUG
            // Extract the minimum cost from the range string as a fallback default
            const minCostMatch = actualActionCost.match(/^(\d+)\s+to/);
            if (minCostMatch?.[1]) { return parseInt(minCostMatch[1], 10); }
            return 1; // Absolute fallback
        }
    }

    // --- Original logic for non-combo, non-variable-override suggestions ---
    // Trust direct item data if it's specific and not from LLM initially
    if (actualActionCost !== null && typeof actualActionCost !== 'string' && costSource !== "LLM") {
        // console.log(`AI | Authoritative Cost: Using specific item cost (${actualActionCost}).`); // DEBUG
        return actualActionCost;
    }

    // If no specific item cost, validate and use LLM cost suggestion
    let validatedLLMCost = llmCost;
    if (validatedLLMCost === 'R' || validatedLLMCost === 'F') {
        // console.log(`AI | Authoritative Cost: Using LLM cost (${validatedLLMCost}).`); // DEBUG
        return validatedLLMCost;
    }
    const numericCost = parseInt(validatedLLMCost, 10);
    if (!isNaN(numericCost) && numericCost >= 1 && numericCost <= 3) {
        // console.log(`AI | Authoritative Cost: Using valid numeric LLM cost (${numericCost}).`); // DEBUG
        return numericCost; // Accept numeric 1-3
    }

    // If we reach here, LLM cost was invalid and item cost was missing, variable, or also LLM-derived initially.
    console.warn(`PF2e AI Combat Assistant | LLM suggested cost (${llmCost}) was invalid or out of range (1-3, R, F) and could not be resolved against item cost (${actualActionCost}). Defaulting authoritative cost to 1 action.`);
    return 1; // Default to 1 action if cost is unusable
}

/**
 * Clears AI-related flags (turn state, processing status, cached strikes) from an actor.
 * Used at the end of a turn, on errors, or when combat ends.
 * @param {ActorPF2e | null} actor - The actor whose flags should be cleared.
 */
async function clearAITurnFlags(actor) {
    if (!actor || !actor.id) {
        // console.warn("PF2e AI Combat Assistant | clearAITurnFlags called with null or invalid actor."); // DEBUG
        return;
    }
    try {
        await actor.unsetFlag(MODULE_ID, FLAGS.TURN_STATE);
        await actor.unsetFlag(MODULE_ID, FLAGS.IS_PROCESSING);
        await actor.unsetFlag(MODULE_ID, FLAGS.CACHED_STRIKES);
        // console.log(`PF2e AI Combat Assistant | Cleared AI flags for actor ${actor.name} (${actor.id}).`); // DEBUG
    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error clearing flags for actor ${actor.name} (${actor.id}):`, error);
    }
}

/**
 * Updates the actor's MAP flag based on the traits of the confirmed action.
 * Increases MAP if the action has the 'attack' trait.
 * Called *after* _onConfirmActionClick successfully updates other state.
 * @param {ActorPF2e} actor - The actor who performed the action.
 * @param {string[]} actionTraits - Array of traits from the confirmed action.
 */
async function _updateMAPBasedOnTrait(actor, actionTraits) {
    if (!actor || !Array.isArray(actionTraits)) return;

    // Only update MAP if the action has the 'attack' trait
    if (!actionTraits.includes('attack')) {
        // console.log(`PF2e AI Combat Assistant | Action confirmed without 'attack' trait. MAP unchanged.`); // DEBUG
        return;
    }

    try {
        // Need to re-get state as it might have just been updated by confirm handler
        const currentTurnState = actor.getFlag(MODULE_ID, FLAGS.TURN_STATE);
        if (!currentTurnState) {
            console.error(`PF2e AI Combat Assistant | MAP Update Error: Turn state missing for ${actor.name} when trying to update MAP.`);
            return; // Cannot update MAP if state is missing
        }

        const currentMAP = currentTurnState.currentMAP ?? 0;
        const isAgile = actionTraits.includes('agile');
        let nextMAP = currentMAP;

        // PF2e MAP progression: 0 -> -5 (or -4 agile) -> -10 (or -8 agile) -> -10 (or -8 agile) ...
        // We store the actual penalty value (0, 4, 5, 8, 10) for internal calculations
        const penaltyIncrement = isAgile ? 4 : 5;

        if (currentMAP === 0) {
            nextMAP = penaltyIncrement; // First attack: 0 -> 4 (agile) or 5 (non-agile)
        } else if (currentMAP === 4 || currentMAP === 5) {
            // Second attack: 4/5 -> 8 (agile) or 10 (non-agile)
            nextMAP = isAgile ? 8 : 10;
        } else {
            // Third+ attack: Stays at 8 (agile) or 10 (non-agile)
            nextMAP = isAgile ? 8 : 10;
        }

        // Only update the flag if the MAP value actually needs to change
        if (nextMAP !== currentMAP) {
            // console.log(`PF2e AI Combat Assistant | Attack trait confirmed. Updating MAP for ${actor.name}: ${currentMAP} -> ${nextMAP} (Agile: ${isAgile})`); // DEBUG
            // Use dot notation to update only the MAP field within the TURN_STATE flag
            await actor.setFlag(MODULE_ID, `${FLAGS.TURN_STATE}.currentMAP`, nextMAP);
        } else {
            // console.log(`PF2e AI Combat Assistant | Attack trait confirmed, but MAP already at maximum (${currentMAP}).`); // DEBUG
        }

    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error updating MAP flag for ${actor.name} after attack confirmation:`, error);
    }
}

// --- Foundry VTT Hooks ---

Hooks.once('init', () => {
    console.log("PF2e AI Combat Assistant | Initializing Module");
});

Hooks.once('ready', () => {
    console.log("PF2e AI Combat Assistant | Foundry Ready");
    registerSettings();
    console.log("PF2e AI Combat Assistant | Settings Initialized");
});
/**
 * Posts or updates the AI Designation Setup message for a given combat.
 * Finds and deletes any previous designation message for the same combat before posting a new one.
 * @param {Combat} combat - The combat encounter document.
 */
async function postOrUpdateDesignationMessage(combat) {
    if (!combat) {
        console.warn("AI DEBUG | postOrUpdateDesignationMessage called with null combat.");
        return;
    }
    console.debug(`AI DEBUG | postOrUpdateDesignationMessage triggered for Combat ID: ${combat.id}`);

    // Allow combatant data to potentially update after creation/deletion
    await new Promise(resolve => setTimeout(resolve, 100));

    const combatants = combat.combatants?.contents;
    if (!combatants || combatants.length === 0) {
        console.debug(`AI DEBUG | postOrUpdateDesignationMessage: No combatants found in combat ${combat.id}. Skipping message post.`);
        // Optionally delete existing message if combat is now empty
        const existingMsgId = `designation-${combat.id}`;
        const existingMsg = game.messages.find(m => m.flags?.[MODULE_ID]?.[FLAGS.DESIGNATION_MSG_ID] === existingMsgId);
        if (existingMsg) {
            console.debug(`AI DEBUG | postOrUpdateDesignationMessage: Deleting existing designation message for empty combat ${combat.id}.`);
            try { await existingMsg.delete(); } catch (e) { console.error("Error deleting old designation message:", e); }
        }
        return;
    }

    // Build the list of combatants for the message
    let combatantListHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
    const currentDesignations = combat.getFlag(MODULE_ID, FLAGS.DESIGNATIONS) || {}; // Get existing designations

    combatants.forEach(combatant => {
        const designation = currentDesignations[combatant.id] || 'enemy'; // Default to enemy if not set
        const isFriendly = designation === 'friendly';
        const icon = isFriendly ? 'fa-heart' : 'fa-skull-crossbones';
        const color = isFriendly ? 'lightgreen' : 'salmon';
        const text = isFriendly ? 'Friendly' : 'Enemy';

        combatantListHtml += `
            <li style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px dashed #ccc; padding: 4px 2px;"
                data-combatant-entry-id="${combatant.id}" data-ai-current-designation="${designation}">
                <div class="ai-combatant-info" style="display: flex; align-items: center; flex-grow: 1; margin-right: 10px;">
                    <img src="${combatant.img || CONST.DEFAULT_TOKEN}" width="24" height="24" style="vertical-align: middle; margin-right: 5px; border: none; flex-shrink: 0;">
                    <strong style="vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${combatant.name}">${combatant.name || 'Unknown Name'}</strong>
                </div>
                <div class="ai-designation-buttons" style="flex-shrink: 0;">
                    <button class="ai-designate-toggle-btn" data-combatant-id="${combatant.id}" title="Toggle AI Designation (Friendly/Enemy)" style="min-width: 80px; background-color: ${color};">
                        <i class="fas ${icon}"></i> ${text}
                    </button>
                </div>
            </li>`;
    });
    combatantListHtml += '</ul>';

    const setupContent = `
        <div class="ai-designation-setup" style="border: 1px solid #ccc; padding: 5px; margin-top: 5px;" data-combat-id="${combat.id}">
            <strong>AI Designation Setup</strong><br>Mark combatants as Friendly or Enemy for the AI. Default is Enemy.
            ${combatantListHtml}<hr style="margin:5px 0;">
            <button class="ai-confirm-designations" title="Save Designations to Combat"><i class="fas fa-save"></i> Confirm Designations</button>
        </div>`;

    const uniqueDesignationMsgId = `designation-${combat.id}`;

    // Find and delete the previous designation message for this combat, if it exists
    const existingMessage = game.messages.find(m => m.flags?.[MODULE_ID]?.[FLAGS.DESIGNATION_MSG_ID] === uniqueDesignationMsgId);
    if (existingMessage) {
        console.debug(`AI DEBUG | postOrUpdateDesignationMessage: Found existing designation message ${existingMessage.id} for combat ${combat.id}. Deleting.`);
        try {
            await existingMessage.delete();
        } catch (deleteError) {
            console.error(`PF2e AI Combat Assistant | Failed to delete previous designation message ${existingMessage.id}:`, deleteError);
        }
    } else {
         console.debug(`AI DEBUG | postOrUpdateDesignationMessage: No existing designation message found for combat ${combat.id}.`);
    }

    // Create the new message (only if there's an active GM)
    if (game.users.activeGM) {
        try {
            console.debug(`AI DEBUG | postOrUpdateDesignationMessage: Attempting to create new designation setup message for combat ${combat.id}.`);
            await ChatMessage.create({
                speaker: { alias: "AI Setup" },
                content: setupContent,
                whisper: ChatMessage.getWhisperRecipients("GM"),
                flags: { [MODULE_ID]: { [FLAGS.DESIGNATION_MSG_ID]: uniqueDesignationMsgId } } // Add the unique ID flag
            });
            console.debug(`AI DEBUG | postOrUpdateDesignationMessage: Designation setup message created successfully for combat ${combat.id}.`);
        } catch (error) {
            console.error(`PF2e AI Combat Assistant | Failed to create designation setup message for combat ${combat.id}:`, error);
        }
    } else {
        console.warn(`AI DEBUG | postOrUpdateDesignationMessage: No active GM found to send designation setup message for combat ${combat.id}.`);
    }
}


Hooks.on('createCombat', async (combat, options, userId) => {
    console.debug(`AI DEBUG | createCombat Hook triggered. Combat ID: ${combat.id}, User ID: ${userId}, Is GM: ${game.user.isGM}`); // DEBUG
    // Only GM should handle this
    if (!game.user.isGM || (userId && userId !== game.userId)) {
         console.debug(`AI DEBUG | createCombat Hook exiting: Not GM or triggered by another user.`); // DEBUG
        return;
    }
    // Post the initial designation message
    await postOrUpdateDesignationMessage(combat);
});

Hooks.on('createCombatant', async (combatant, options, userId) => {
    // Only GM should handle this setup prompt
    console.debug(`AI DEBUG | createCombatant Hook triggered for Combatant: ${combatant?.name}, Combat ID: ${combatant?.combat?.id}, User ID: ${userId}, Is GM: ${game.user.isGM}`); // DEBUG
    if (!game.user.isGM || (userId && userId !== game.userId)) {
        console.debug(`AI DEBUG | createCombatant Hook exiting: Not GM or triggered by another user.`); // DEBUG
        return;
    }

    const combat = combatant.combat;
    // Only prompt if the combat is already active/started
    console.debug(`AI DEBUG | createCombatant: Checking conditions - Combat Exists: ${!!combat}, Combat Started: ${combat?.started}, Combatant Actor Exists: ${!!combatant?.actor}`); // DEBUG
    // TODO: Re-evaluate if combat.started check is correct here. Maybe prompt even if not started?
    if (!combat || !combat.started || !combatant?.actor) {
         console.debug(`AI DEBUG | createCombatant Hook exiting: Combat missing, not started, or combatant lacks actor.`); // DEBUG
        return;
    }

    console.debug(`AI DEBUG | createCombatant: Conditions met for ${combatant.name} in Combat ${combat.id}. Currently NO action taken here.`); // DEBUG
    // TODO: Add logic here to potentially re-trigger or update the designation message.
    await new Promise(resolve => setTimeout(resolve, 200)); // Small delay

    // Get existing designations, default to enemy if not set
    const existingDesignations = combat.getFlag(MODULE_ID, FLAGS.DESIGNATIONS) || {};
    let currentDesignation = existingDesignations[combatant.id] || 'enemy'; // Default new combatants to enemy
    let currentIcon = (currentDesignation === 'friendly') ? 'fa-smile' : 'fa-skull-crossbones';
    let currentColor = (currentDesignation === 'friendly') ? 'lightgreen' : 'salmon';

    const promptContent = `
        <div class="ai-single-designation-prompt" style="border: 1px solid #ccc; padding: 5px; margin-top: 5px;"
             data-combat-id="${combat.id}" data-combatant-id="${combatant.id}" data-current-designation="${currentDesignation}">
             <strong>AI Designation for New Combatant</strong><br>How should the AI treat <strong>${combatant.name || 'Unknown Name'}</strong>?
             <div style="display: flex; align-items: center; justify-content: space-around; margin-top: 5px;">
                 <button class="ai-designate-single" data-designation="friendly" style="background-color: lightgreen; flex-grow: 1; margin-right: 5px;" title="Set as Friendly"><i class="fas fa-smile"></i> Friendly</button>
                 <button class="ai-designate-single" data-designation="enemy" style="background-color: salmon; flex-grow: 1;" title="Set as Enemy"><i class="fas fa-skull-crossbones"></i> Enemy</button>
            </div>
            <div class="ai-designation-current" style="text-align: center; margin-top: 3px; font-size: 0.9em;">(Currently: <span style="color: ${currentColor};"><i class="fas ${currentIcon}"></i> ${currentDesignation.charAt(0).toUpperCase() + currentDesignation.slice(1)}</span>)</div>
        </div>`;

    try {
        await ChatMessage.create({
            speaker: { alias: "AI Setup" },
            content: promptContent,
            whisper: ChatMessage.getWhisperRecipients("GM")
        });
        // console.log(`PF2e AI Combat Assistant | Single designation prompt posted for ${combatant.name}.`); // DEBUG
    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Failed to create single designation prompt message:`, error);
    }
});

Hooks.on('updateCombat', async (combat, updateData, options, userId) => {
    // Check if the turn or round changed in an active combat
    console.debug(`AI DEBUG | updateCombat Hook triggered. Combat started: ${combat.started}, Update Data:`, updateData); // DEBUG
    if (!combat.started || (updateData.turn === undefined && updateData.round === undefined)) {
        console.debug(`AI DEBUG | updateCombat Hook exiting: Combat not started or no turn/round update.`); // DEBUG
        return;
    }
    // Ignore trivial updates (like initiative changes outside of turn/round advance)
    if (options?.diff === false && options?.advanceTime === 0) return;

    await new Promise(resolve => setTimeout(resolve, 75)); // Short delay to ensure combatant data is updated

    const previousCombatantId = combat.previous?.combatantId;
    const currentCombatant = combat.combatant;

    // --- Cleanup previous combatant's AI flags ---
    if (previousCombatantId && (updateData.turn !== undefined || updateData.round !== undefined)) {
        const previousCombatant = combat.combatants.get(previousCombatantId);
        if (previousCombatant?.actor?.getFlag(MODULE_ID, FLAGS.IS_PROCESSING)) {
            try {
                // console.log(`PF2e AI Combat Assistant | Turn ended for ${previousCombatant.name}, clearing AI processing flags.`); // DEBUG
                await clearAITurnFlags(previousCombatant.actor);
            } catch (flagError) {
                console.error(`PF2e AI Combat Assistant | Error clearing flags for previous combatant ${previousCombatant.name}:`, flagError);
            }
        }
    }

    // --- Offer AI control for the current combatant ---
    console.debug(`AI DEBUG | Current Combatant: ${currentCombatant?.name}, Actor Exists: ${!!currentCombatant?.actor}`); // DEBUG
    if (!currentCombatant?.actor) {
        console.debug(`AI DEBUG | updateCombat Hook exiting: No actor found for current combatant.`); // DEBUG
        return; // No actor for the current turn
    }

    const actor = currentCombatant.actor;

    // Skip offer if the actor has an active player owner and the setting is GM-only
    const hasActivePlayerOwner = actor.hasPlayerOwner && game.users.some(user => user.active && actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
    console.debug(`AI DEBUG | Actor: ${actor.name}, hasPlayerOwner: ${actor.hasPlayerOwner}, Calculated hasActivePlayerOwner: ${hasActivePlayerOwner}, showOfferToPlayers: ${game.settings.get(MODULE_ID, 'showOfferToPlayers')}, isGM: ${game.user.isGM}`); // DEBUG
    if (hasActivePlayerOwner && !game.settings.get(MODULE_ID, 'showOfferToPlayers') && !game.user.isGM) {
        console.debug(`AI DEBUG | updateCombat Hook exiting: Offer skipped (Player ${game.user.name} owns token, GM-only setting, user is not GM).`); // DEBUG
        return; // Player owns this token, GM-only setting, player is not GM -> no offer shown to this player
    }
    if (!hasActivePlayerOwner && !game.user.isGM) {
        console.debug(`AI DEBUG | updateCombat Hook exiting: Offer skipped (Player ${game.user.name} does not own NPC, GM-only setting).`); // DEBUG
        return; // Player does not own token, GM-only setting active -> no offer shown to this player
    }

    // Generate a unique ID for this specific turn's offer to prevent duplicates
    const uniqueOfferId = `ai-offer-${combat.id}-${combat.round}-${combat.turn}`;
    console.debug(`AI DEBUG | Generated uniqueOfferId: ${uniqueOfferId}`); // DEBUG

    // Check if an offer message with this ID already exists
    const existingMessage = game.messages.find(message => message.flags?.[MODULE_ID]?.[FLAGS.OFFER_ID] === uniqueOfferId);
    console.debug(`AI DEBUG | Checking for existing message with ID ${uniqueOfferId}. Found: ${!!existingMessage}`); // DEBUG
    if (existingMessage) {
        console.debug(`AI DEBUG | updateCombat Hook exiting: AI Offer message for turn ${uniqueOfferId} already exists.`); // DEBUG
        return;
    }

    const offerContent = `
        <div style="border: 1px solid #ccc; padding: 5px; margin-top: 5px;">
            <strong>Turn: ${currentCombatant.name}</strong> (Round ${combat.round ?? '?'}, Turn ${(combat.turn ?? -1) + 1})<br>Use AI suggestions for this turn?
            <hr style="margin:3px 0 5px 0;">
            <button class="ai-accept-control" data-combatant-id="${currentCombatant.id}" title="Let the AI suggest actions"><i class="fas fa-robot"></i> Accept AI</button>
            <button class="ai-decline-control" data-combatant-id="${currentCombatant.id}" title="Control manually"><i class="fas fa-user"></i> Decline AI</button>
            <button class="ai-skip-turn" data-combatant-id="${currentCombatant.id}" title="Skip this combatant's turn"><i class="fas fa-forward"></i> Skip Turn</button>
        </div>`;

    try {
        console.debug(`AI DEBUG | Attempting to create AI offer chat message for ${currentCombatant.name}...`); // DEBUG
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: currentCombatant.token || actor.prototypeToken }),
            content: offerContent,
            whisper: getWhisperRecipientsOffer(), // Respect setting for who sees the offer
            flags: { [MODULE_ID]: { [FLAGS.OFFER_ID]: uniqueOfferId } } // Add the unique ID flag
        });
        console.debug(`AI DEBUG | AI offer chat message created successfully for ${currentCombatant.name}.`); // DEBUG
    } catch (chatError) {
        console.error(`PF2e AI Combat Assistant | Failed to create AI offer message:`, chatError);
    }
});

Hooks.on('renderChatMessage', (message, html, data) => {
    // Prevent duplicate listeners
    const listenerFlagAttribute = `data-ai-listeners-added-${message.id}`;
    if (html.attr(listenerFlagAttribute)) return;
    html.attr(listenerFlagAttribute, 'true');

    // --- Designation Setup Listeners (GM Only) ---
    const designationSetupDiv = html.find('.ai-designation-setup');
    if (designationSetupDiv.length > 0) {
        if (game.user.isGM) {
            designationSetupDiv.find('button.ai-designate-toggle-btn').off('click').on('click', _onToggleDesignationClick);
            designationSetupDiv.find('button.ai-confirm-designations').off('click').on('click', _onConfirmDesignationsClick);
        } else {
            // Disable buttons for non-GMs
            designationSetupDiv.find('button').prop('disabled', true).attr('title', 'GM only');
        }
    }
    // --- Single Designation Prompt Listeners (GM Only) ---
    const singlePromptDiv = html.find('.ai-single-designation-prompt');
    if (singlePromptDiv.length > 0) {
        if (game.user.isGM) {
            singlePromptDiv.find('button.ai-designate-single').off('click').on('click', _onDesignateSingleClick);
        } else {
            singlePromptDiv.find('button').prop('disabled', true).attr('title', 'GM only');
        }
    }

    // --- AI Control & Suggestion Listeners (Respect showOfferToPlayers setting visibility) ---
    // Players might see these if setting allows, but some actions might still be GM-only
    html.find('button.ai-accept-control').off('click').on('click', _onAcceptControlClick);
    html.find('button.ai-decline-control').off('click').on('click', _onDeclineControlClick);
    html.find('button.ai-skip-turn').off('click').on('click', _onSkipTurnClick); // Added Skip Turn listener
    html.find('button.ai-confirm-action').off('click').on('click', _onConfirmActionClick);
    html.find('button.ai-skip-action').off('click').on('click', _onSkipActionClick);
    html.find('button.ai-apply-condition-reduction').off('click').on('click', _onApplyConditionReductionClick); // ADDED listener for new button
    html.find('button.ai-retry-turn').off('click').on('click', _onRetryTurnClick); // ADDED listener for Retry button
    html.find('button.ai-end-turn').off('click').on('click', _onEndTurnClick);
    // GM-Only execution buttons (will be disabled visually via generateSuggestionButtons if not GM)
    html.find('button.ai-cast-spell').off('click').on('click', _onCastSpellClick);
    html.find('button.ai-execute-strike').off('click').on('click', _onExecuteStrikeClick);
    // Removed listener for ai-show-item as button is removed
    // html.find('button.ai-show-item').off('click').on('click', _onShowItemClick);
    // Next Turn button (typically on end-of-turn messages, GM only)
    html.find('button.ai-next-turn-btn').off('click').on('click', _onNextTurnClick);
    // MAP Adjustment Radios
    html.find('input.ai-map-adjust-radio').off('change').on('change', _onManualMAPAdjust);
});

Hooks.on('deleteCombat', async (combat, options, userId) => {
    // console.log(`PF2e AI Combat Assistant | Combat ${combat.id} deleted. Cleaning up AI flags.`); // DEBUG
    if (!combat?.combatants) return;

    for (const combatant of combat.combatants) {
        if (combatant.actor) {
            try {
                await clearAITurnFlags(combatant.actor);
            } catch (error) {
                console.error(`PF2e AI Combat Assistant | Error clearing flags for actor ${combatant.actor.name} during combat deletion:`, error);
            }
        }
    }
});

Hooks.on('deleteCombatant', async (combatant, options, userId) => {
    const combat = combatant.combat;
    // console.log(`PF2e AI Combat Assistant | Combatant ${combatant?.name ?? 'Unknown'} deleted/removed. Cleaning flags.`); // DEBUG

    // Clear AI flags from the actor regardless of who deleted it
    if (combatant.actor) {
        try {
            await clearAITurnFlags(combatant.actor);
        } catch (error) {
            console.error(`PF2e AI Combat Assistant | Error clearing flags for deleted combatant ${combatant.actor.name}:`, error);
        }
    }

    // Remove designation entry from combat flags (GM only)
    if (!combat || !game.user.isGM) return;
    try {
        const currentDesignations = combat.getFlag(MODULE_ID, FLAGS.DESIGNATIONS);
        if (currentDesignations && combatant.id in currentDesignations) {
            // console.log(`PF2e AI Combat Assistant | Removing designation for deleted combatant ${combatant.name}.`); // DEBUG
            const updatedDesignations = { ...currentDesignations };
            delete updatedDesignations[combatant.id];
            await combat.setFlag(MODULE_ID, FLAGS.DESIGNATIONS, updatedDesignations);
        }
    } catch (error) {
        console.warn(`PF2e AI Combat Assistant | Could not remove designation for deleted combatant ${combatant.name}:`, error);
    }
});


// --- Chat Button Handlers ---

async function _onToggleDesignationClick(event) {
    event.preventDefault();
    if (!game.user.isGM) return; // Should be blocked by renderChatMessage, but double-check

    const button = $(event.currentTarget);
    const listItem = button.closest('li');
    if (!listItem) return;

    const currentDesignation = listItem.data('ai-current-designation') || 'enemy';
    const newDesignation = (currentDesignation === 'friendly' ? 'enemy' : 'friendly');
    const newIcon = (newDesignation === 'friendly' ? 'fa-smile' : 'fa-skull-crossbones');
    const newColor = (newDesignation === 'friendly' ? 'lightgreen' : 'salmon');

    // Update the list item's data attribute and the button appearance
    listItem.data('ai-current-designation', newDesignation);
    button.css('background-color', newColor)
        .html(`<i class="fas ${newIcon}"></i> ${newDesignation.charAt(0).toUpperCase() + newDesignation.slice(1)}`);
}

async function _onConfirmDesignationsClick(event) {
    event.preventDefault();
    if (!game.user.isGM) return;

    const button = $(event.currentTarget);
    const container = button.closest('.ai-designation-setup');
    const combatId = container.data('combatId');
    if (!combatId) {
        console.error("AI Assistant | Could not find combatId on designation setup container for toggle.");
        return; // Cannot proceed without combat ID
    }
    const combat = game.combats.get(combatId);

    if (!combat) {
        ui.notifications.error("PF2e AI Combat Assistant Error: Combat not found for designation confirmation!");
        return;
    }

    // Disable buttons during save
    button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Saving...');
    container.find('button').prop('disabled', true); // Disable toggle buttons too

    const designationsToSave = {};
    container.find('li[data-combatant-entry-id]').each((index, element) => {
        const listItem = $(element);
        const combatantEntryId = listItem.data('combatantEntryId');
        const designation = listItem.data('ai-current-designation') || 'enemy'; // Default to enemy if somehow missing
        if (combatantEntryId) {
            designationsToSave[combatantEntryId] = designation;
        }
    });

    try {
        await combat.setFlag(MODULE_ID, FLAGS.DESIGNATIONS, designationsToSave);
        // console.log(`PF2e AI Combat Assistant | Designations saved for combat ${combat.id}.`, designationsToSave); // DEBUG
        button.html('<i class="fas fa-check"></i> Saved');
        // Optionally post a confirmation message (GM only)
        ChatMessage.create({
            content: `AI designations saved for combat ${combat.name || combat.id}.`,
            whisper: ChatMessage.getWhisperRecipients("GM")
        });
        // Note: Buttons remain disabled after saving to prevent accidental changes.
        // The chat card is now just a record.
    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Failed to save designations:`, error);
        ui.notifications.error("PF2e AI Combat Assistant Error: Failed to save designations. Check console.");
        button.html('<i class="fas fa-times"></i> Failed');
        // Re-enable buttons on failure to allow retry
        container.find('button').prop('disabled', false);
        button.html('<i class="fas fa-save"></i> Confirm Designations'); // Reset button text
    }
}

async function _onDesignateSingleClick(event) {
    event.preventDefault();
    if (!game.user.isGM) return;

    const button = $(event.currentTarget);
    const promptDiv = button.closest('.ai-single-designation-prompt');
    const combatId = promptDiv.data('combatId');
    const targetCombatantId = promptDiv.data('combatantId');
    const newDesignation = button.data('designation');
    const combat = game.combats.get(combatId);

    if (!combat) { ui.notifications.error("PF2e AI Combat Assistant Error: Combat not found for single designation!"); return; }
    const targetCombatant = combat.combatants.get(targetCombatantId);
    if (!targetCombatant) { ui.notifications.error("PF2e AI Combat Assistant Error: Combatant not found in combat for single designation!"); return; }

    // Disable buttons during save
    promptDiv.find('button').prop('disabled', true);
    button.html('<i class="fas fa-spinner fa-spin"></i> Saving...');

    try {
        // Get current flags, update the specific combatant, set back
        const currentDesignations = combat.getFlag(MODULE_ID, FLAGS.DESIGNATIONS) || {};
        currentDesignations[targetCombatantId] = newDesignation;
        await combat.setFlag(MODULE_ID, FLAGS.DESIGNATIONS, currentDesignations);
        // console.log(`PF2e AI Combat Assistant | Designation for ${targetCombatant.name} set to ${newDesignation}.`); // DEBUG

        // Update the button that was clicked and the status display
        button.html(`<i class="fas fa-check"></i> ${newDesignation.charAt(0).toUpperCase() + newDesignation.slice(1)}`);
        const newIcon = (newDesignation === 'friendly') ? 'fa-smile' : 'fa-skull-crossbones';
        const newColor = (newDesignation === 'friendly') ? 'lightgreen' : 'salmon';
        promptDiv.find('.ai-designation-current span')
            .css('color', newColor)
            .html(`<i class="fas ${newIcon}"></i> ${newDesignation.charAt(0).toUpperCase() + newDesignation.slice(1)}`);

        // Optional confirmation message
        ChatMessage.create({
            content: `AI designation for ${targetCombatant.name} set to ${newDesignation}.`,
            whisper: ChatMessage.getWhisperRecipients("GM")
        });
        // Keep other button disabled
        promptDiv.find('button').not(button).prop('disabled', true);

    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Failed to save single designation:`, error);
        ui.notifications.error("PF2e AI Combat Assistant Error: Failed to save designation. Check console.");
        // Re-enable buttons on failure
        promptDiv.find('button').prop('disabled', false);
        // Reset the clicked button's original content
        const originalIcon = (button.data('designation') === 'friendly') ? 'fa-smile' : 'fa-skull-crossbones';
        button.html(`<i class="fas ${originalIcon}"></i> ${button.data('designation').charAt(0).toUpperCase() + button.data('designation').slice(1)}`);
    }
}


async function _onAcceptControlClick(event) {
    event.preventDefault();
    // console.log("PF2e AI Combat Assistant | Accept AI clicked."); // DEBUG
    const button = $(event.currentTarget);
    const combatantId = button.data('combatantId');
    const combat = game.combat; // Get the current active combat

    if (!combat) { ui.notifications.error("PF2e AI Combat Assistant Error: No active combat found!"); return; }
    const combatant = combat.combatants.get(combatantId);
    const actor = combatant?.actor;
    if (!actor) { ui.notifications.error("PF2e AI Combat Assistant Error: Combatant or Actor not found!"); return; }

    // Disable buttons on the offer card
    button.closest('.message-content').find('button').prop('disabled', true);
    button.html('<i class="fas fa-spinner fa-spin"></i> Accepted');

    // --- Critical Check: Is it still this combatant's turn? ---
    if (combat.combatant?.id !== combatantId) {
        ui.notifications.warn(`PF2e AI Combat Assistant: It is no longer ${combatant.name}'s turn! Cannot start AI control.`);
        button.html('<i class="fas fa-times"></i> Not Turn');
        // Don't clear flags here, the updateCombat hook should handle cleanup
        return;
    }

    try {
        // Set flags to indicate AI is processing this actor's turn
        await actor.setFlag(MODULE_ID, FLAGS.IS_PROCESSING, true);
        // Initialize turn state: 3 actions, empty history, MAP 0, empty manual notes
        await actor.setFlag(MODULE_ID, FLAGS.TURN_STATE, {
            actionsRemaining: 3,
            actionsTakenDescriptions: [],
            currentMAP: 0,
            manualNotes: "" // Initialize manual notes
        });
        // Clear any cached strikes from a potential previous run
        await actor.unsetFlag(MODULE_ID, FLAGS.CACHED_STRIKES);

        // Post a message indicating AI is taking over
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken }),
            content: `<i>${combatant.name} accepts AI guidance...</i>`,
            whisper: getWhisperRecipientsSuggestions() // Use suggestion visibility
        });

        // Initiate the first suggestion request (pass null for manual notes initially)
        await new Promise(resolve => setTimeout(resolve, 150)); // Short delay
        await requestNextAISuggestion(combatant, combat, null, null); // Pass null for skippedAction and manualNotes

    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error initializing AI turn:`, error);
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken }),
            content: `<i style="color:red;">Error starting AI turn: ${error.message}</i>`,
            whisper: getWhisperRecipientsSuggestions()
        });
        // Clean up flags on error
        await clearAITurnFlags(actor);
        // Re-enable buttons on the original offer card in case of init error
        button.closest('.message-content').find('button').prop('disabled', false);
        button.html('<i class="fas fa-robot"></i> Accept AI');
    }
}

async function _onDeclineControlClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    // Disable buttons on the offer card
    button.closest('.message-content').find('button').prop('disabled', true);
    button.html('<i class="fas fa-check"></i> Manual Control');

    const combatant = game.combat?.combatants.get(button.data('combatantId'));
    if (combatant) {
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: combatant.token || combatant.actor?.prototypeToken }),
            content: `<i>${combatant.name} controlled manually this turn...</i>`,
            whisper: getWhisperRecipientsOffer() // Respect offer visibility
        });
    }
}

/**
 * Handles clicking the "Skip Turn" button on the AI offer message.
 * Advances the combat tracker to the next turn.
 * @param {Event} event - The click event.
 * @private
 */
async function _onSkipTurnClick(event) {
    event.preventDefault();
    console.log("PF2e AI Combat Assistant | Skip Turn button clicked."); // DEBUG

    const button = event.currentTarget;
    const combatantId = button.dataset.combatantId;
    const combat = game.combat;

    if (!combat) {
        ui.notifications.warn("PF2e AI Combat Assistant: No active combat found.");
        return;
    }

    const combatant = combat.combatants.get(combatantId);

    if (!combatant) {
        ui.notifications.error(`PF2e AI Combat Assistant: Could not find combatant with ID ${combatantId}.`);
        return;
    }

    // Check permissions - Only GM or the user controlling the current combatant should skip
    const isGM = game.user.isGM;
    const isOwner = combatant.actor?.testUserPermission(game.user, "OWNER");
    const isCurrentTurn = combat.combatant?.id === combatantId;

    if (!isGM && !isOwner) {
        ui.notifications.warn("PF2e AI Combat Assistant: You do not have permission to skip this turn.");
        return;
    }

    if (!isCurrentTurn) {
        ui.notifications.warn(`PF2e AI Combat Assistant: It is not currently ${combatant.name}'s turn.`);
        // Allow GM override maybe? For now, strict check.
        return;
    }

    console.log(`PF2e AI Combat Assistant | Skipping turn for ${combatant.name}.`);
    ui.notifications.info(`Skipping turn for ${combatant.name}.`);

    try {
        // Disable buttons on the message to prevent double clicks
        $(button).closest('.chat-message').find('button').prop('disabled', true);
        await combat.nextTurn();
    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error skipping turn for ${combatant.name}:`, error);
        ui.notifications.error(`PF2e AI Combat Assistant: Failed to skip turn. See console (F12) for details.`);
        // Re-enable buttons on error? Maybe not, state might be inconsistent.
    }
}

async function _onConfirmActionClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const suggestionCard = button.closest('.message-content');
    const combatantId = button.data('combatantId');
    // Correctly retrieve the cost used for validation (passed from requestNextAISuggestion -> generateSuggestionButtons)
    const actionCostForValidation = parseInt(button.data('actionCost'), 10);
    const actionDescription = decodeURIComponent(button.data('actionDesc') || 'Unknown Action'); // Full description from LLM/parsing
    const messageId = suggestionCard.closest('.chat-message').data('messageId'); // Get message ID
    const combat = game.combat;

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant Confirm Error: No active combat."); return; }
    const combatant = combat.combatants.get(combatantId);
    const actor = combatant?.actor;
    if (!actor) { ui.notifications.error("PF2e AI Combat Assistant Confirm Error: Combatant or Actor not found."); return; }

    // --- Get Manual Notes from Text Input ---
    let manualNotes = "";
    if (messageId) {
        const inputId = game.messages.get(messageId)?.getFlag(MODULE_ID, FLAGS.MANUAL_NOTES_INPUT_ID);
        if (inputId) {
            manualNotes = $(`#${inputId}`).val() || "";
            // console.log(`AI Confirm: Retrieved Manual Notes: "${manualNotes}"`); // DEBUG
        } else {
            // console.warn(`AI Confirm: Could not find input field ID flag on message ${messageId}`); // DEBUG
        }
    } else {
        console.warn("AI Confirm: Could not find message ID to retrieve manual notes.");
    }


    // Disable buttons on suggestion card
    suggestionCard.find('button').prop('disabled', true);
    suggestionCard.find('input[type="radio"]').prop('disabled', true); // Disable MAP radios too
    suggestionCard.find('.ai-manual-notes-input').prop('disabled', true); // Disable manual input
    button.html('<i class="fas fa-spinner fa-spin"></i> Confirmed...');

    // --- Critical Check: Is it still this combatant's turn? ---
    if (combat.combatant?.id !== combatantId) {
        ui.notifications.warn(`PF2e AI Combat Assistant: Turn has advanced, cannot confirm action for ${combatant.name}.`);
        button.html('<i class="fas fa-times"></i> Turn Ended');
        await clearAITurnFlags(actor); // Clean up flags if turn ended unexpectedly
        return;
    }

    // Get current state
    const currentTurnState = actor.getFlag(MODULE_ID, FLAGS.TURN_STATE);
    if (!currentTurnState) {
        ui.notifications.error("PF2e AI Combat Assistant Confirm Error: Turn state flag missing!");
        button.html('<i class="fas fa-times"></i> State Error');
        await clearAITurnFlags(actor);
        return;
    }

    // Validate action cost against remaining actions
    // Allow 0 cost actions (Free/Reactions handled by logic, combos have final cost)
    if (isNaN(actionCostForValidation) || actionCostForValidation < 0 || actionCostForValidation > currentTurnState.actionsRemaining) {
        ui.notifications.error(`PF2e AI Combat Assistant Confirm Error: Action cost (${actionCostForValidation}) is invalid or exceeds remaining actions (${currentTurnState.actionsRemaining}).`);
        button.html('<i class="fas fa-times"></i> Cost Error');
        // Re-enable buttons on this card if cost was the issue
        suggestionCard.find('button').prop('disabled', false);
        suggestionCard.find('input[type="radio"]').prop('disabled', false);
        suggestionCard.find('.ai-manual-notes-input').prop('disabled', false);
        button.html('<i class="fas fa-check"></i> Confirm');
        return;
    }

    // --- Identify Traits for MAP update ---
    let identifiedTraits = [];
    try {
        // Re-identify the suggestion to get the traits of the main action, even if it's a combo
        const identifyResult = await identifySuggestionTypeAndCost(actionDescription, actor, {}); // Pass empty gameState as we only need identification
        if (identifyResult && Array.isArray(identifyResult.traits)) {
            identifiedTraits = identifyResult.traits;
        } else {
            // console.warn(`AI Confirm: Could not reliably re-identify action "${actionDescription.substring(0, 30)}..." to get traits for MAP. MAP will not auto-update.`); // DEBUG
        }
        // console.log(`AI Confirm: Identified traits for MAP check: [${identifiedTraits.join(', ')}] for action: "${actionDescription}"`); // DEBUG
    } catch (identifyError) {
        // console.warn(`AI Confirm: Error during re-identification for MAP check:`, identifyError); // DEBUG
    }
    // --- End Trait Identification ---

    // Update Turn State
    const newActionsRemaining = Math.max(0, currentTurnState.actionsRemaining - actionCostForValidation); // Use the validated cost

    // --- Extract Narrative and Clean Description ---
    // The full description is stored in actionDescription (e.g., "Cast Fireball (Rank 3), Area | Rationale: Good AoE | NARRATIVE: Unleashes fire!")
    // We need to separate the core action description from the rationale and narrative parts.
    let cleanedActionDesc = actionDescription;
    let narrativeForThisAction = "";
    const rationaleSeparator = " | Rationale: ";
    const narrativeSeparator = " | NARRATIVE: "; // Assuming this separator might exist if parsing failed earlier

    // Attempt to extract narrative using the separator first
    const narrativeIndex = cleanedActionDesc.indexOf(narrativeSeparator);
    if (narrativeIndex !== -1) {
        narrativeForThisAction = cleanedActionDesc.substring(narrativeIndex + narrativeSeparator.length).trim();
        cleanedActionDesc = cleanedActionDesc.substring(0, narrativeIndex).trim();
    }

     // Attempt to remove rationale using the separator
    const rationaleIndex = cleanedActionDesc.indexOf(rationaleSeparator);
     if (rationaleIndex !== -1) {
         // We don't need the rationale itself here, just remove it from the description
         cleanedActionDesc = cleanedActionDesc.substring(0, rationaleIndex).trim();
     }

     // Fallback: If separators weren't found, try the parseLLMSuggestion logic again
     // This is less ideal performance-wise but provides a backup.
     if (!narrativeForThisAction && rationaleIndex === -1) { // Only re-parse if BOTH separators failed
         const tempParsed = parseLLMSuggestion(actionDescription); // Re-parse to get parts if needed
         if (tempParsed) {
             cleanedActionDesc = tempParsed.description || cleanedActionDesc; // Use parsed description if available
             narrativeForThisAction = tempParsed.narrative || ""; // Use parsed narrative if available
             // Rationale is implicitly removed by taking tempParsed.description
         }
     }
    // --- End Extraction ---

    const newActionsTakenDescriptions = [...(currentTurnState.actionsTakenDescriptions || []), cleanedActionDesc]; // Store cleaned description
    const newNarrativesTaken = [...(currentTurnState.narrativesTaken || []), narrativeForThisAction].filter(n => n && n.length > 0); // Store narrative, filter empty strings

    // Create the new state object, preserving existing MAP for now, clearing manual notes
    const newTurnState = {
        ...currentTurnState,
        actionsRemaining: newActionsRemaining,
        actionsTakenDescriptions: newActionsTakenDescriptions,
        narrativesTaken: newNarrativesTaken, // Add narratives array
        manualNotes: "" // Clear manual notes after confirming
    };

    try {
        // Save the updated state (excluding MAP update for now)
        await actor.setFlag(MODULE_ID, FLAGS.TURN_STATE, newTurnState);
        // console.log(`PF2e AI Combat Assistant Action Confirmed: "${actionDescription}". State Updated: Actions Left=${newActionsRemaining}`); // DEBUG

        // NOW, update MAP based on the identified traits *after* state is saved
        await _updateMAPBasedOnTrait(actor, identifiedTraits);

        // --- Store the ID of the *suggestion* message that was just confirmed ---
        // Subsequent chat messages will be processed by handleChatMessage if their ID is greater
        lastConfirmedActionMessageIds.set(combatant.id, messageId);
        // console.log(`AI Confirm | Stored last processed msg ID: ${messageId} for ${combatant.name}`); // DEBUG

        // Request the next suggestion, passing the retrieved manual notes AND the updated turn state
        await new Promise(resolve => setTimeout(resolve, 150)); // Short delay
        await requestNextAISuggestion(combatant, combat, null, manualNotes, newTurnState); // Pass updated state


    } catch (stateUpdateError) {
        console.error(`PF2e AI Combat Assistant State Update Error after confirming action:`, stateUpdateError);
        ui.notifications.error("PF2e AI Combat Assistant Error: Failed state update...");
        button.html('<i class="fas fa-times"></i> State Error');
        await clearAITurnFlags(actor); // Clear flags on error
        // Don't re-enable buttons here, state is likely broken
    }
}


async function _onSkipActionClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const suggestionCard = button.closest('.message-content');
    const combatantId = button.data('combatantId');
    const skippedActionDescription = decodeURIComponent(button.data('actionDesc') || 'Unknown Action');
    const messageId = suggestionCard.closest('.chat-message').data('messageId'); // Get message ID
    const combat = game.combat;

    // console.log(`PF2e AI Combat Assistant | Skip Clicked. Combatant ID: ${combatantId}`); // DEBUG

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant Skip Error: No active combat."); return; }
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) { ui.notifications.error(`PF2e AI Combat Assistant Skip Error: Combatant not found.`); suggestionCard.find('button').prop('disabled', true); button.html('<i class="fas fa-times"></i> Error'); return; }
    const actor = combatant.actor;
    if (!actor) { ui.notifications.error(`PF2e AI Combat Assistant Skip Error: Actor missing.`); suggestionCard.find('button').prop('disabled', true); button.html('<i class="fas fa-times"></i> Error'); return; }

    // --- Get Manual Notes from Text Input ---
    let manualNotes = "";
    if (messageId) {
        const inputId = game.messages.get(messageId)?.getFlag(MODULE_ID, FLAGS.MANUAL_NOTES_INPUT_ID);
        if (inputId) {
            manualNotes = $(`#${inputId}`).val() || "";
            // console.log(`AI Skip: Retrieved Manual Notes: "${manualNotes}"`); // DEBUG
        } else {
            // console.warn(`AI Skip: Could not find input field ID flag on message ${messageId}`); // DEBUG
        }
    } else {
        console.warn("AI Skip: Could not find message ID to retrieve manual notes.");
    }

    // Disable buttons on the card being skipped
    suggestionCard.find('button').prop('disabled', true);
    suggestionCard.find('input[type="radio"]').prop('disabled', true); // Disable MAP radios too
    suggestionCard.find('.ai-manual-notes-input').prop('disabled', true); // Disable manual input
    button.html('<i class="fas fa-spinner fa-spin"></i> Skipping...');

    // --- Critical Check: Is it still this combatant's turn? ---
    if (combat.combatant?.id !== combatantId) {
        ui.notifications.warn(`PF2e AI Combat Assistant: Turn has advanced, cannot skip action for ${combatant.name}.`);
        button.html('<i class="fas fa-times"></i> Turn Ended');
        await clearAITurnFlags(actor); // Clean up flags
        return;
    }

    // --- Critical Check: Is AI still processing? ---
    if (!actor.getFlag(MODULE_ID, FLAGS.IS_PROCESSING) || !actor.getFlag(MODULE_ID, FLAGS.TURN_STATE)) {
        ui.notifications.error("PF2e AI Combat Assistant Skip Error: AI state is missing or not active!");
        button.html('<i class="fas fa-times"></i> State Error');
        await clearAITurnFlags(actor); // Clean up flags
        return;
    }

    // --- Update State with Manual Notes ---
    try {
        let currentTurnState = actor.getFlag(MODULE_ID, FLAGS.TURN_STATE);
        if (!currentTurnState) {
            ui.notifications.error("PF2e AI Combat Assistant Skip Error: Could not retrieve turn state to reset actions.");
            button.html('<i class="fas fa-times"></i> State Error');
            await clearAITurnFlags(actor);
            return;
        }
        let updatedTurnState = deepClone(currentTurnState); // Use deepClone for safety
        // Actions remaining are preserved from currentTurnState
        updatedTurnState.manualNotes = manualNotes; // Include latest notes

        await actor.setFlag(MODULE_ID, FLAGS.TURN_STATE, updatedTurnState);
        // console.log("AI Skip: Updated turn state with manual notes.", updatedTurnState); // DEBUG

        // Request next suggestion, passing the skipped action, notes, AND the updated state
        await new Promise(resolve => setTimeout(resolve, 150)); // Short delay
        await requestNextAISuggestion(combatant, combat, skippedActionDescription, manualNotes, updatedTurnState); // Pass updated state

    } catch (e) {
        console.error("AI Skip: Failed to reset actions or request next suggestion:", e);
        ui.notifications.error("PF2e AI Combat Assistant Skip Error: Failed to process skip.");
        button.html('<i class="fas fa-times"></i> Error');
        await clearAITurnFlags(actor); // Clean up on error
    }


    // Requesting next suggestion is now handled within the try...catch block above
}

async function _onEndTurnClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const suggestionCard = button.closest('.message-content');
    const combatantId = button.data('combatantId');
    const combat = game.combat;

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant End Turn Error: No active combat."); return; }
    const combatant = combat.combatants.get(combatantId);
    const actor = combatant?.actor;

    // Disable buttons on the card
    suggestionCard.find('button').prop('disabled', true);
    suggestionCard.find('input[type="radio"]').prop('disabled', true);
    suggestionCard.find('.ai-manual-notes-input').prop('disabled', true); // Disable manual input
    button.html('<i class="fas fa-spinner fa-spin"></i> Ending AI...');

    if (!actor) {
        button.html('<i class="fas fa-ban"></i> AI Ended (No Actor)');
        // console.warn("PF2e AI Combat Assistant: Actor not found when trying to end AI turn manually."); // DEBUG
        return; // Cannot clear flags if no actor
    }

    // Get final state and gather fresh game state for summary
    const finalTurnState = actor.getFlag(MODULE_ID, FLAGS.TURN_STATE);

    let narrativeSummary = "The turn was ended manually."; // Default summary
    let recentEvents = [];
    try {
        // Gather final game state to get recent events
        const gameState = await gatherGameState(combatant, combat, 0, actor); // Assume 0 actions left for final state
        recentEvents = gameState?.recentEvents || [];

        // --- Generate Narrative Summary using LLM ---
        const summaryPrompt = craftTurnSummaryPrompt(combatant, finalTurnState?.actionsTakenDescriptions, recentEvents);
        // console.log("PF2e AI Combat Assistant | Manual Turn End Summary Prompt:", summaryPrompt); // DEBUG
        const apiKey = game.settings.get(MODULE_ID, 'apiKey');
        const endpoint = game.settings.get(MODULE_ID, 'llmEndpoint');
        const modelName = game.settings.get(MODULE_ID, 'aiModel');

        if (apiKey && endpoint && modelName) {
            const llmResponse = await callLLM(summaryPrompt, apiKey, endpoint, modelName);
            // Use the entire trimmed response as the narrative, assuming the prompt instructions were followed.
            if (llmResponse && llmResponse.trim()) {
                narrativeSummary = llmResponse.trim();
            } else {
                console.warn("PF2e AI Combat Assistant | Received empty or invalid narrative summary from LLM response (manual end):", llmResponse);
                narrativeSummary = "The AI finished its turn (manually ended), but the narrative summary was empty.";
            }
        } else {
            console.warn("PF2e AI Combat Assistant | LLM settings missing, cannot generate narrative summary (manual end).");
            narrativeSummary = "LLM settings missing; narrative summary unavailable.";
        }
        // --- End Narrative Summary Generation ---

    } catch (gatherOrLLMError) {
        console.error("PF2e AI Combat Assistant | Error during manual turn end summary generation:", gatherOrLLMError);
        narrativeSummary = "An error occurred while summarizing the manually ended turn.";
    }

    // Get intended actions list for details block
    const actionsListHtml = finalTurnState?.actionsTakenDescriptions?.map(desc => `<li>${desc}</li>`).join('') || '<li>No actions recorded.</li>';
    // Format recent events for details block
    const recentEventsHtml = recentEvents.length > 0
        ? recentEvents.map(event => `<li>${event}</li>`).join('')
        : '<li>No significant events recorded.</li>';

    // Get speaker data which respects token name visibility
    const speakerData = ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken });
    const displayName = speakerData.alias || actor.name; // Use alias (respects Anonymous) or fallback to actor name

    // Construct the final message with the narrative
    // Construct the final message with Intended Actions first, then Narrative
    const manualEndContent = `
         <strong>${displayName}'s AI Turn Ended Manually</strong><br>
         Intended Actions:<ul>${actionsListHtml}</ul>
         <p style="margin: 5px 0 5px 0; font-style: italic; border-top: 1px dashed #ccc; padding-top: 5px;">${narrativeSummary}</p>
         <details>
             <summary style="cursor: pointer; font-size: 0.9em;">Recorded Events (GM Only)</summary>
             <div style="padding-left: 15px; font-size: 0.9em;">
                 <ul>${recentEventsHtml}</ul>
             </div>
         </details>
         <hr style="margin:5px 0;">
         <button class="ai-next-turn-btn" data-combatant-id="${combatant.id}" title="Advance turn (GM Only)"><i class="fas fa-arrow-right"></i> Next Turn</button>
     `;

    // Determine whisper recipients based on setting
    const whisperRecipients = game.settings.get(MODULE_ID, 'whisperTurnSummary')
        ? ChatMessage.getWhisperRecipients("GM")
        : [];

    // Create the chat message
    ChatMessage.create({
        speaker: speakerData, // Use the pre-calculated speaker data
        content: manualEndContent,
        whisper: whisperRecipients // Set whisper based on setting
    });

    try {
        await clearAITurnFlags(actor);
        lastConfirmedActionMessageIds.delete(combatant.id); // Clear last action ID map entry on turn end
        // console.log(`AI End Turn | Cleared last processed msg ID for ${combatant.name}`); // DEBUG
    } catch (flagClearError) {
        console.error(`PF2e AI Combat Assistant | Error clearing flags on manual end turn:`, flagClearError);
    }

    button.html('<i class="fas fa-ban"></i> AI Ended');

    // Notify GM if they aren't seeing player messages
    if (game.user.isGM && !game.settings.get(MODULE_ID, 'showOfferToPlayers')) {
        ui.notifications.info(`${combatant.name}'s AI turn ended manually.`);
    }
}
// --- NEW Handler for Apply Condition Reduction Button ---
async function _onApplyConditionReductionClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const actorId = button.data('actor-id');
    const stunnedChange = parseInt(button.data('stunned-change'), 10);
    const slowedChange = parseInt(button.data('slowed-change'), 10);

    if (!actorId) {
        console.error("AI Apply Condition: Missing actor ID.");
        ui.notifications.error("AI Apply Condition: Missing actor ID.");
        return;
    }
    // --- Get Actor from Combatant/Token ---
    const combatant = game.combat?.combatants.find(c => c.actorId === actorId);
    const tokenDocument = combatant?.token;
    const actor = tokenDocument?.actor; // Get the potentially synthetic actor from the token

    if (!actor) {
        console.error(`AI Apply Condition: Could not find token actor instance for actor ID ${actorId} in the current combat.`);
        ui.notifications.error(`AI Apply Condition: Could not find token actor instance.`);
        return;
    }
    // --- End Actor Fetching ---

    // GM Check - Only allow GMs to click this button
    if (!game.user.isGM) {
        ui.notifications.warn("Only GMs can apply AI condition changes.");
        return;
    }

    try {
        let updates = [];
        let notification = [`Applied condition changes for ${actor.name}:`];

        // Handle Stunned using standard Actor methods
        if (stunnedChange !== 0) {
            const stunnedCondition = actor.itemTypes.condition.find(c => c.slug === 'stunned');
            if (stunnedCondition) {
                const currentValue = stunnedCondition.system?.value?.value ?? 0; // Get value from system data
                if (stunnedChange === -1 || currentValue <= stunnedChange) { // Remove
                    await actor.deleteEmbeddedDocuments("Item", [stunnedCondition.id]);
                    notification.push(`- Removed Stunned ${currentValue}.`);
                } else { // Reduce
                    const newValue = currentValue - stunnedChange;
                    await actor.updateEmbeddedDocuments("Item", [{ _id: stunnedCondition.id, "system.value.value": newValue }]);
                    notification.push(`- Reduced Stunned ${currentValue} by ${stunnedChange} (New: ${newValue}).`);
                }
            } else {
                 notification.push(`- Stunned condition not found on actor.`);
            }
        }

        // Handle Slowed using standard Actor methods
        if (slowedChange !== 0) {
            const slowedCondition = actor.itemTypes.condition.find(c => c.slug === 'slowed');
             if (slowedCondition) {
                const currentValue = slowedCondition.system?.value?.value ?? 0; // Get value from system data
                if (slowedChange === -1 || currentValue <= slowedChange) { // Remove
                    await actor.deleteEmbeddedDocuments("Item", [slowedCondition.id]);
                    notification.push(`- Removed Slowed ${currentValue}.`);
                } else { // Reduce
                    const newValue = currentValue - slowedChange;
                     await actor.updateEmbeddedDocuments("Item", [{ _id: slowedCondition.id, "system.value.value": newValue }]);
                    notification.push(`- Reduced Slowed ${currentValue} by ${slowedChange} (New: ${newValue}).`);
                }
            } else {
                 notification.push(`- Slowed condition not found on actor.`);
            }
        }

        ui.notifications.info(notification.join('\n'));
        // Optionally disable the button after clicking
        button.prop('disabled', true).find('i').removeClass('fa-check').addClass('fa-check-double');

        // --- Check if turn should end (from 0-action start message) ---
        const endTurn = button.data('end-turn') === true;
        if (endTurn) {
            const combat = game.combat;
            if (combat && combat.combatant?.actorId === actorId) {
                console.log(`AI Apply Condition: Ending turn for ${actor.name} after applying 0-action condition changes.`);
                await combat.nextTurn();
            } else {
                 console.warn(`AI Apply Condition: Tried to end turn for ${actor.name}, but combat state changed.`);
                 ui.notifications.warn(`Could not automatically end turn for ${actor.name}. Combat state may have changed.`);
            }
        }
        // --- End Turn Check ---

    } catch (error) {
        console.error(`AI Apply Condition: Error applying changes for actor ${actorId}:`, error);
        ui.notifications.error(`AI Apply Condition: Error applying changes. See console.`);
    }
}
// --- END NEW Handler ---

// --- NEW Handler for Retry Turn Button ---
async function _onRetryTurnClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const combatantId = button.data('combatant-id');

    if (!game.user.isGM) {
        ui.notifications.warn("Only GMs can retry AI turns.");
        return;
    }

    if (!combatantId) {
        console.error("AI Retry Turn: Missing combatant ID.");
        ui.notifications.error("AI Retry Turn: Missing combatant ID.");
        return;
    }

    const combat = game.combat;
    if (!combat) {
        console.error("AI Retry Turn: No active combat found.");
        ui.notifications.error("AI Retry Turn: No active combat.");
        return;
    }

    const combatant = combat.combatants.get(combatantId);
    if (!combatant) {
        console.error(`AI Retry Turn: Could not find combatant with ID ${combatantId}.`);
        ui.notifications.error("AI Retry Turn: Combatant not found.");
        return;
    }

    // Ensure it's actually this combatant's turn before retrying
    if (combat.combatant?.id !== combatant.id) {
         console.warn(`AI Retry Turn: Attempted retry for ${combatant.name}, but it's not their turn.`);
         ui.notifications.warn(`Cannot retry turn for ${combatant.name}, it's not their turn.`);
         return;
    }

    console.log(`AI Retry Turn: Retrying turn for ${combatant.name} (ID: ${combatantId})`);
    ui.notifications.info(`Retrying AI turn start for ${combatant.name}...`);

    // Re-call the main suggestion function to restart the process
    // Pass null for skippedAction and manualNotes initially for a fresh start
    await requestNextAISuggestion(combatant, combat, null, null, null);

    // Optionally disable the retry button after clicking
    button.prop('disabled', true);
}
// --- END NEW Handler ---
// REMOVING DUPLICATED _onRetryTurnClick function block


/**
 * Applies a temporary cooldown effect to an actor after using a limited-use ability.
 * @param {ActorPF2e} actor - The actor who used the ability.
 * @param {ItemPF2e} ability - The ability (spell, feat, action) item that was used.
 */
// REMOVING DUPLICATED COMMENT LINES
async function applyCooldownEffect(actor, ability) {
    if (!actor || !ability || !ability.system || !ability.slug) return;

    const frequency = ability.system.frequency;
    if (!frequency || !frequency.per || !(frequency.max > 0)) {
        // console.log(`AI applyCooldownEffect: Ability "${ability.name}" has no limited frequency. No effect applied.`); // DEBUG
        return; // Only apply effects for limited-use abilities
    }

    let durationInRounds = 0;
    switch (frequency.per) {
        case 'round':
        case 'turn': // Treat turn-based frequency like round-based for effect duration
            durationInRounds = 1;
            break;
        case 'minute':
            durationInRounds = 10;
            break;
        case 'hour':
            durationInRounds = 600;
            break;
        case 'day':
            durationInRounds = 14400;
            break;
        case 'combat':
            // For 'per combat', set a long duration (e.g., 1 day) as a simple approximation.
            // A more complex solution might involve linking to the combat ID.
            durationInRounds = 14400;
            // console.log(`AI applyCooldownEffect: Using 1-day duration for 'per combat' frequency on "${ability.name}".`); // DEBUG
            break;
        default:
            // console.warn(`AI applyCooldownEffect: Unknown frequency period "${frequency.per}" for ability "${ability.name}". Cannot apply effect.`); // DEBUG
            return; // Don't apply effect for unknown periods
    }

    if (durationInRounds <= 0) {
        // console.warn(`AI applyCooldownEffect: Calculated duration is zero or less for "${ability.name}". Cannot apply effect.`); // DEBUG
        return;
    }

    const effectSlug = `pf2e-ai-combat-assistant-cooldown-${ability.slug}-${frequency.per}`;
    const effectName = `Cooldown: ${ability.name} (${frequency.per})`;

    const effectData = {
        _id: null, // Let Foundry generate ID
        name: effectName,
        type: 'effect',
        img: ability.img || 'icons/svg/misc/clock.svg', // Use ability icon or fallback
        system: {
            slug: effectSlug,
            description: {
                value: `This effect indicates that the AI has used the limited-use ability "${ability.name}" and it is currently on cooldown based on its frequency (${frequency.max} per ${frequency.per}).`,
                chat: '', // No chat description needed
                unidentified: false
            },
            rules: [], // No specific rules needed for this marker effect
            traits: {
                value: [], // No traits needed
                rarity: 'common',
                custom: ''
            },
            level: { value: ability.level ?? 0 }, // Use ability level if available
            source: { value: `PF2e AI Combat Assistant Module` },
            duration: {
                value: durationInRounds,
                unit: 'rounds',
                sustained: false,
                expiry: 'turn-start' // Expire at the start of the actor's turn
            },
            start: { // Set start time for duration calculation
                value: game.time.worldTime,
                initiative: game.combat?.combatant?.initiative ?? null
            },
            target: null, // Not targeted
            tokenIcon: { show: true }, // Show icon on token
            unidentified: false,
            context: null // Not linked to a specific roll
        },
        flags: {
            [MODULE_ID]: {
                isCooldown: true,
                sourceAbilityUuid: ability.uuid,
                sourceAbilityName: ability.name,
                frequencyPer: frequency.per
            }
        }
    };

    try {
        // console.log(`AI applyCooldownEffect: Creating effect "${effectName}" (Slug: ${effectSlug}) on ${actor.name} for ${durationInRounds} rounds.`); // DEBUG
        await actor.createEmbeddedDocuments("Item", [effectData]);
        // console.log(`AI applyCooldownEffect: Successfully created cooldown effect for "${ability.name}".`); // DEBUG
    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error creating cooldown effect for "${ability.name}" on ${actor.name}:`, error);
    }
}

async function _onCastSpellClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const suggestionCard = button.closest('.message-content'); // Keep reference for inputs
    const spellId = button.data('spellId');
    const entryId = button.data('entryId');
    const combatantId = button.data('combatantId');
    const spellUUID = button.data('spellUuid');
    const requestedRankStr = button.data('spellRank'); // Get rank from button
    const combat = game.combat;

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant Cast Error: No active combat."); return; }
    const combatant = combat.combatants.get(combatantId);
    const actor = combatant?.actor;
    if (!actor) { ui.notifications.error("PF2e AI Combat Assistant Cast Error: Combatant or Actor not found."); return; }

    // --- Critical Check: Is it still this combatant's turn? ---
    if (combat.combatant?.id !== combatantId) {
        ui.notifications.warn(`PF2e AI Combat Assistant: Not ${combatant.name}'s turn! Cannot cast spell.`);
        // Do not disable buttons here, just prevent action
        return;
    }

    // --- GM Only Check ---
    if (!game.user.isGM) {
        ui.notifications.warn("PF2e AI Combat Assistant: Only GMs can execute Cast actions from suggestions currently.");
        return;
    }

    let spellToCast = null;
    let spellcastingEntry = null;
    let isItemGrantedSpell = false;

    // --- Identify the Spell and Entry ---
    // Priority 1: Spell ID and Entry ID (Standard spells from spellbook)
    if (entryId && spellId) {
        spellcastingEntry = actor.spellcasting?.get(entryId);
        if (!spellcastingEntry) {
            ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Spellcasting entry '${entryId}' not found on ${actor.name}.`);
            return;
        }
        spellToCast = spellcastingEntry.spells?.get(spellId);
        if (!spellToCast) {
            ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Spell '${spellId}' not found in entry '${entryId}'.`);
            return;
        }
        isItemGrantedSpell = false; // Explicitly false for spellbook spells
        // console.log(`PF2e AI Combat Assistant: Identified spellbook spell '${spellToCast.name}' from entry '${spellcastingEntry.name}'.`); // DEBUG
    }
    // Priority 2: Item Spell UUID (Fallback if no entry/spell ID)
    else if (spellUUID) {
        try {
            spellToCast = await fromUuid(spellUUID);
            if (!spellToCast || spellToCast.type !== 'spell') {
                ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Could not resolve UUID '${spellUUID}' or it is not a spell.`);
                return;
            }
            // Find *any* suitable spellcasting entry to use for the cast method
            // This is imperfect, might need refinement based on how PF2e handles item casts
            spellcastingEntry = actor.spellcasting?.find(e => e.canCast(spellToCast, { origin: actor })) // Check if entry *could* cast it
                || actor.spellcasting?.[0]; // Fallback to first entry
            if (!spellcastingEntry) {
                ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Cannot cast item spell '${spellToCast.name}' - no suitable spellcasting entry found on ${actor.name}.`);
                return;
            }
            isItemGrantedSpell = true;
            // console.log(`PF2e AI Combat Assistant: Identified item spell '${spellToCast.name}' via UUID, using entry '${spellcastingEntry.name}' for casting method.`); // DEBUG
        } catch (uuidError) {
            ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Error resolving item spell UUID '${spellUUID}': ${uuidError.message}`);
            return;
        }
    }
    // Error if neither method worked
    else {
        ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Missing data (UUID or EntryID/SpellID) to identify spell.`);
        return;
    }

    // --- Determine Slot/Resource for Casting ---
    let targetSlotRank = null;
    let targetSlotIndex = null; // Only relevant for prepared slots
    const maxSpellRank = CONFIG.PF2E?.spellLevels ?? 10;
    const baseSpellRank = spellToCast.rank;
    let requestedRank = parseInt(requestedRankStr, 10);
    if (isNaN(requestedRank) || requestedRank < baseSpellRank) {
        // console.warn(`PF2e AI Combat Assistant Cast: Invalid requested rank '${requestedRankStr}' for spell '${spellToCast.name}' (Base Rank: ${baseSpellRank}). Falling back to default slot finding.`); // DEBUG
        requestedRank = null; // Invalidate if not a number or below base rank
    }

    if (isItemGrantedSpell) {
        // For item spells, assume it's cast at its base rank unless overwritten? PF2e might handle this internally.
        targetSlotRank = baseSpellRank;
        targetSlotIndex = null; // Not applicable
    } else if (spellcastingEntry) {
        if (spellToCast.isCantrip) {
            targetSlotRank = baseSpellRank;
            targetSlotIndex = null;
        } else if (spellToCast.isFocusSpell) {
            if (actor.system.resources?.focus?.value > 0) {
                targetSlotRank = baseSpellRank; // Focus spells cast at base rank
                targetSlotIndex = null;
            }
        } else if (spellcastingEntry.isPrepared) {
            // --- Prepared Casting ---
            let foundRequestedRank = false;
            // console.log(`PF2e AI Combat Assistant Cast (Prepared): Requested Rank = ${requestedRank}, Spell ID = ${spellId}`); // DEBUG
            if (requestedRank !== null) {
                // 1. Check if the SPECIFIC requested rank has an available prepared slot
                const slotKey = `slot${requestedRank}`;
                const slotData = spellcastingEntry.system.slots?.[slotKey];
                console.log(`   Checking Rank ${requestedRank} (Slot Key: ${slotKey}). Slot Data:`, slotData);
                if (slotData?.prepared) {
                    const foundIndex = slotData.prepared.findIndex((prep, idx) => {
                        const isMatch = prep?.id === spellId && !prep?.expended;
                        // console.log(`      Rank ${requestedRank} Slot ${idx}: Prep ID=${prep?.id}, Target ID=${spellId}, Expended=${prep?.expended}, Match=${isMatch}`); // DEBUG
                        return isMatch;
                    });
                    console.log(`      Found Index for Spell ID ${spellId} at Rank ${requestedRank}: ${foundIndex}`);
                    if (foundIndex !== -1) {
                        targetSlotRank = requestedRank;
                        targetSlotIndex = foundIndex;
                        foundRequestedRank = true;
                        console.log(`   SUCCESS: Using requested prepared rank ${targetSlotRank}, Slot Index ${targetSlotIndex} for '${spellToCast.name}'.`);
                    } else {
                        console.log(`      Spell ID ${spellId} not found or expended in Rank ${requestedRank} prepared slots.`);
                    }
                } else {
                    console.log(`      No prepared slots found for Rank ${requestedRank}.`);
                }
                if (!foundRequestedRank) {
                     console.warn(`   WARN: Requested prepared rank ${requestedRank} for '${spellToCast.name}' not available/prepared. Falling back.`);
                }
            }

            // 2. Fallback: Find highest available prepared slot if requested rank failed
            // 2. Fallback: Find highest available prepared slot if requested rank failed
            if (!foundRequestedRank) {
                console.log(`   FALLBACK: Searching for highest available prepared rank for Spell ID ${spellId}...`);
                let highestAvailablePreparedRank = -1;
                let highestFoundIndex = -1; // Store the index for the highest rank found
                for (let rank = maxSpellRank; rank >= baseSpellRank; rank--) {
                    const slotKey = `slot${rank}`;
                    const slotData = spellcastingEntry.system.slots?.[slotKey];
                    // console.log(`      Fallback Check Rank ${rank} (Slot Key: ${slotKey}). Slot Data:`, slotData); // Verbose
                    if (!slotData?.prepared) continue;
                    const foundIndex = slotData.prepared.findIndex((prep, idx) => {
                         const isMatch = prep?.id === spellId && !prep?.expended;
                         // console.log(`         Fallback Rank ${rank} Slot ${idx}: Prep ID=${prep?.id}, Target ID=${spellId}, Expended=${prep?.expended}, Match=${isMatch}`); // DEBUG
                         return isMatch;
                    });
                    // console.log(`         Found Index at Rank ${rank}: ${foundIndex}`); // Verbose
                    if (foundIndex !== -1) {
                        // Found an available slot for this spell at this rank
                        if (rank > highestAvailablePreparedRank) {
                            // If this rank is higher than any previously found, update tracking
                            highestAvailablePreparedRank = rank;
                            highestFoundIndex = foundIndex; // *** Assign the index found for this rank ***
                            console.log(`         Found higher available rank: ${rank}, Index: ${foundIndex}`);
                        }
                        // We keep checking lower ranks in case the user *wants* a lower rank,
                        // but the fallback prioritizes the *highest* available.
                    }
                }
                // Assign the highest found rank and its index *after* checking all ranks
                if (highestAvailablePreparedRank !== -1) {
                    targetSlotRank = highestAvailablePreparedRank;
                    targetSlotIndex = highestFoundIndex; // Use the index found for the highest rank
                    console.log(`   FALLBACK SUCCESS: Using highest available prepared rank ${targetSlotRank}, Slot Index ${targetSlotIndex} for '${spellToCast.name}'.`);
                } else {
                    console.warn(`   FALLBACK FAILED: No available prepared slot found for Spell ID ${spellId} at any rank.`);
                }
            }
        } else if (spellcastingEntry.isSpontaneous || spellcastingEntry.isFlexible) {
            // --- Spontaneous/Flexible Casting ---
            let foundRequestedRank = false;
            if (requestedRank !== null) {
                 // 1. Check if the SPECIFIC requested rank has available slots
                 const slotKey = `slot${requestedRank}`;
                 const slotData = spellcastingEntry.system.slots?.[slotKey];
                 if (slotData && slotData.value > (slotData.expended ?? 0)) {
                     targetSlotRank = requestedRank;
                     targetSlotIndex = null; // No specific slot index
                     foundRequestedRank = true;
                     // console.log(`PF2e AI Combat Assistant Cast: Using requested spontaneous rank ${targetSlotRank} for '${spellToCast.name}'.`); // DEBUG
                 } else {
                     // console.warn(`PF2e AI Combat Assistant Cast: Requested spontaneous rank ${requestedRank} for '${spellToCast.name}' has no slots available. Falling back.`); // DEBUG
                 }
            }

            // 2. Fallback: Find lowest available slot if requested rank failed
            if (!foundRequestedRank) {
                for (let rank = baseSpellRank; rank <= maxSpellRank; rank++) {
                    const slotKey = `slot${rank}`;
                    const slotData = spellcastingEntry.system.slots?.[slotKey];
                    if (slotData && slotData.value > (slotData.expended ?? 0)) {
                        targetSlotRank = rank;
                        targetSlotIndex = null;
                        // console.log(`PF2e AI Combat Assistant Cast: Fallback - Using lowest available spontaneous rank ${targetSlotRank} for '${spellToCast.name}'.`); // DEBUG
                        break; // Use the lowest available
                    }
                }
            }
        }
        // If no resource found after checking types
        if (targetSlotRank === null && !spellToCast.isCantrip) {
            ui.notifications.error(`PF2e AI Combat Assistant Cast Error: No available slot/resource found for '${spellToCast.name}' in entry '${spellcastingEntry.name}'.`);
            return;
        }
    } else {
        // Should not happen if spell/entry identification worked
        ui.notifications.error(`PF2e AI Combat Assistant Cast Error: Could not determine casting resource for '${spellToCast.name}'.`);
        return;
    }

    // --- Execute the Cast ---
    const originalButtonContent = button.html();
    button.html('<i class="fas fa-spinner fa-spin"></i> Casting...');

    try {
        const castRank = targetSlotRank; // The rank determined above

        // --- DETAILED LOGGING ---
        console.groupCollapsed(`PF2e AI Combat Assistant | Attempting Spell Cast: ${spellToCast.name}`);
        console.log(`Spell:`, spellToCast);
        console.log(`Actor:`, actor);
        console.log(`Spellcasting Entry:`, spellcastingEntry);
        console.log(`Is Item Spell:`, isItemGrantedSpell);
        console.log(`Requested Rank (from button):`, requestedRank);
        console.log(`Base Spell Rank:`, baseSpellRank);
        console.log(`Determined Target Rank:`, targetSlotRank);
        console.log(`Determined Target Slot Index (Prepared Only):`, targetSlotIndex);
        console.groupEnd();
        // --- END LOGGING ---

        if (targetSlotRank === null) {
             throw new Error(`Could not determine a valid rank to cast the spell at.`);
        }

        // console.log(`PF2e AI Combat Assistant | GM executing cast: ${spellToCast.name} from ${isItemGrantedSpell ? 'item' : 'entry ' + spellcastingEntry.name} at rank ${castRank} (Slot Index: ${targetSlotIndex})...`); // DEBUG

        // Use the spellcasting entry's cast method
        await spellcastingEntry.cast(spellToCast, { rank: castRank, slotId: targetSlotIndex });

        // *** APPLY COOLDOWN EFFECT ON SUCCESS ***
        await applyCooldownEffect(actor, spellToCast);
        // *** END COOLDOWN EFFECT ***

        // Success! Keep button disabled as the action was taken.
        button.html(originalButtonContent); // Optionally reset appearance
        // console.log(`PF2e AI Combat Assistant | Cast successful via spellcasting entry method.`); // DEBUG
        // Consider confirming the action automatically here if desired? Or leave it manual.

    } catch (castError) {
        console.error(`PF2e AI Combat Assistant | Error casting spell '${spellToCast.name}':`, castError);
        ui.notifications.error(`PF2e AI Combat Assistant Cast Error: ${castError.message || 'Could not cast spell.'}`);
        // Re-enable buttons on failure
        button.html(originalButtonContent);
    }
}

async function _onExecuteStrikeClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const suggestionCard = button.closest('.message-content');
    const strikeIdentifier = button.data('strikeIdentifier'); // Can be slug or label
    const originatingItemId = button.data('originatingItemId'); // <<< NEW: Get originating item ID
    const combatantId = button.data('combatantId');
    const combat = game.combat;

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant Strike Error: No active combat."); return; }
    const combatant = combat.combatants.get(combatantId);
    const actor = combatant?.actor;
    if (!actor) { ui.notifications.error("PF2e AI Combat Assistant Strike Error: Attacker Combatant or Actor not found."); return; }

    // --- Critical Check: Is it still this combatant's turn? ---
    if (combat.combatant?.id !== combatantId) {
        ui.notifications.warn(`PF2e AI Combat Assistant: Not ${combatant.name}'s turn! Cannot execute strike.`);
        return;
    }

    // --- GM Only Check ---
    if (!game.user.isGM) {
        ui.notifications.warn("PF2e AI Combat Assistant: Only GMs can execute Strike actions from suggestions currently.");
        return;
    }

    if (!strikeIdentifier) {
        ui.notifications.error(`PF2e AI Combat Assistant Strike Error: Missing strike identifier on button.`);
        return;
    }

    // --- Find the Strike Action ---
    // Use the actor's current actions for reliability
    const strikeActions = actor.system.actions?.filter(a => a.type === 'strike');
    const strikeAction = strikeActions?.find(action =>
        action.slug === strikeIdentifier || action.label === strikeIdentifier || action.name === strikeIdentifier
    );

    if (!strikeAction) {
        ui.notifications.error(`PF2e AI Combat Assistant Strike Error: Could not find strike action matching identifier "${strikeIdentifier}" on ${actor.name}. Check if the action exists or if the identifier is correct.`);
        return;
    }
    // Check if the strike has rollable variants (basic requirement)
    if (typeof strikeAction.variants?.[0]?.roll !== 'function') {
        ui.notifications.error(`PF2e AI Combat Assistant Strike Error: Strike action "${strikeAction.label || strikeAction.name}" found, but no rollable variant[0].`);
        return;
    }

    // --- Determine which MAP variant to use ---
    const currentTurnState = actor.getFlag(MODULE_ID, FLAGS.TURN_STATE);
    const currentMAP = currentTurnState?.currentMAP ?? 0; // Default to 0 if state missing
    let variantIndex = 0; // Default to first variant (MAP 0)
    // Note: PF2e system stores MAP penalties as 0, 5/4, 10/8 internally usually
    if (currentMAP === 5 || currentMAP === 4) { // Second attack penalty
        variantIndex = 1;
    } else if (currentMAP === 10 || currentMAP === 8) { // Third attack penalty
        variantIndex = 2;
    }
    // Ensure the selected variant exists
    if (!strikeAction.variants[variantIndex]) {
        // console.warn(`PF2e AI Combat Assistant: Strike "${strikeAction.label}" - MAP is ${currentMAP}, calculated variant index ${variantIndex}, but variant doesn't exist. Falling back to last available variant.`); // DEBUG
        variantIndex = strikeAction.variants.length - 1;
        if (variantIndex < 0) {
            ui.notifications.error(`PF2e AI Combat Assistant Strike Error: Strike action "${strikeAction.label}" has no valid variants.`);
            return;
        }
    }

    // --- Execute the Strike ---
    const originalButtonContent = button.html();
    button.html('<i class="fas fa-spinner fa-spin"></i> Rolling Strike...');

    try {
        const variantLabel = strikeAction.variants[variantIndex]?.label || `Variant ${variantIndex}`;
        // console.log(`PF2e AI Combat Assistant | GM Rolling strike "${strikeAction.label || strikeAction.name}" using ${variantLabel} (MAP ${currentMAP})...`); // DEBUG

        // Roll the selected variant
        // Use a simplified event object focusing on shiftKey for MAP selection
        const fakeEvent = { shiftKey: variantIndex > 0, ctrlKey: false, metaKey: false, type: 'click' };
        await strikeAction.variants[variantIndex].roll({ event: fakeEvent });

        // console.log(`PF2e AI Combat Assistant | Strike roll initiated.`); // DEBUG

        // *** APPLY COOLDOWN EFFECT IF ORIGINATING ITEM ID EXISTS ***
        if (originatingItemId) {
            const originatingItem = actor.items.get(originatingItemId);
            if (originatingItem) {
                // console.log(`AI _onExecuteStrikeClick: Found originating item "${originatingItem.name}" (ID: ${originatingItemId}). Applying cooldown.`); // DEBUG
                await applyCooldownEffect(actor, originatingItem);
            } else {
                console.warn(`AI _onExecuteStrikeClick: Could not find originating item with ID "${originatingItemId}" on actor ${actor.name} to apply cooldown.`);
            }
        } else {
            // console.log(`AI _onExecuteStrikeClick: No originating item ID provided for strike "${strikeIdentifier}". No cooldown applied.`); // DEBUG
        }
        // *** END COOLDOWN EFFECT ***

        button.html(originalButtonContent); // Reset appearance
        // Consider confirming the action automatically here?

    } catch (strikeError) {
        console.error(`PF2e AI Combat Assistant | Error rolling strike '${strikeAction.label || strikeAction.name}':`, strikeError);
        ui.notifications.error(`PF2e AI Combat Assistant Strike Error: ${strikeError.message || 'Could not roll strike.'}`);
        // Re-enable buttons on failure
        button.html(originalButtonContent);
    }
}

async function _onNextTurnClick(event) {
    event.preventDefault();
    const button = $(event.currentTarget);
    const finishedCombatantId = button.data('combatantId');
    const combat = game.combat;

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant: No active combat found."); button.html('<i class="fas fa-times"></i> No Combat').prop('disabled', true); return; }
    if (!combat.started) { ui.notifications.info("PF2e AI Combat Assistant: Combat has already ended."); button.html('<i class="fas fa-ban"></i> Combat Ended').prop('disabled', true); return; }

    // --- GM Only Check ---
    if (!game.user.isGM) {
        ui.notifications.warn("PF2e AI Combat Assistant: Only GMs can advance the turn using this button.");
        return;
    }

    // --- Check if turn was already advanced ---
    // If the current combatant ID doesn't match the one on the button, the turn likely advanced already.
    if (combat.combatant && combat.combatant.id !== finishedCombatantId) {
        ui.notifications.info("PF2e AI Combat Assistant: Turn was already advanced.");
        button.html('<i class="fas fa-check"></i> Turn Advanced').prop('disabled', true);
        return;
    }

    button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Advancing...');

    try {
        await combat.nextTurn();
        // console.log(`PF2e AI Combat Assistant | Turn advanced via 'Next Turn' button.`); // DEBUG
        // Button remains disabled after successful advancement
    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error advancing turn:`, error);
        ui.notifications.error("PF2e AI Combat Assistant: Could not advance turn. Check console.");
        // Re-enable button on failure
        button.prop('disabled', false).html('<i class="fas fa-arrow-right"></i> Next Turn');
    }
}

async function _onManualMAPAdjust(event) {
    event.preventDefault();
    const radio = $(event.currentTarget);
    const combatantId = radio.data('combatantId');
    const mapValue = parseInt(radio.data('mapValue'), 10); // MAP Penalty Value (0, 4, 5, 8, 10)
    const combat = game.combat;

    // Validate MAP value
    if (isNaN(mapValue) || ![0, 4, 5, 8, 10].includes(mapValue)) {
        console.error("PF2e AI Combat Assistant: Invalid MAP value from radio button:", radio.data('mapValue'));
        return;
    }

    if (!combat) { ui.notifications.warn("PF2e AI Combat Assistant: No active combat."); return; }
    const combatant = combat.combatants.get(combatantId);
    const actor = combatant?.actor;
    if (!actor) { ui.notifications.error("PF2e AI Combat Assistant: Combatant or Actor not found."); return; }

    // --- Critical Checks ---
    // Is it this combatant's turn?
    // Is the AI currently processing this combatant's turn?
    if (combat.combatant?.id !== combatantId || !actor.getFlag(MODULE_ID, FLAGS.IS_PROCESSING)) {
        ui.notifications.warn(`PF2e AI Combat Assistant: Cannot adjust MAP for ${combatant.name} - not their turn or AI not active.`);
        // Disable the radio buttons on this card if interaction attempted when not allowed
        radio.closest('.ai-map-adjust-controls').find('input').prop('disabled', true).attr('title', 'MAP adjustment disabled - AI not active for this turn.');
        return;
    }

    const currentTurnState = actor.getFlag(MODULE_ID, FLAGS.TURN_STATE);
    if (!currentTurnState) {
        ui.notifications.error("PF2e AI Combat Assistant: Turn state missing! Cannot adjust MAP.");
        return;
    }

    // Don't update if value hasn't changed
    if (currentTurnState.currentMAP === mapValue) return;

    // console.log(`PF2e AI Combat Assistant | Manually setting MAP for ${combatant.name} to ${mapValue}`); // DEBUG

    try {
        // Update only the MAP field within the TURN_STATE flag using dot notation
        await actor.setFlag(MODULE_ID, `${FLAGS.TURN_STATE}.currentMAP`, mapValue);

        // Visual feedback (optional fade)
        const controlsDiv = radio.closest('.ai-map-adjust-controls');
        controlsDiv.css('opacity', 0.5);
        await new Promise(resolve => setTimeout(resolve, 300));
        controlsDiv.css('opacity', 1.0);

    } catch (error) {
        console.error(`PF2e AI Combat Assistant: Error setting manual MAP flag:`, error);
        ui.notifications.error("PF2e AI Combat Assistant: Failed to update MAP state.");
        // Consider reverting radio button? Or just leave it as is.
    }
}


// --- Core AI Logic Functions ---

// `requestNextAISuggestion`: Orchestrates the AI request cycle, includes manual notes.
async function requestNextAISuggestion(combatant, combat, skippedAction = null, manualNotes = null, updatedTurnState = null) { // Add updatedTurnState parameter
    const suggestionInstanceId = foundry.utils.randomID(10); // Unique ID for MAP radio group and input field
    const manualInputId = `ai-manual-notes-${suggestionInstanceId}`; // ID for the text input

    // console.log(`PF2e AI Combat Assistant | Entering requestNextAISuggestion for ${combatant?.name ?? 'Unknown Combatant'}`); // DEBUG
    if (!combatant || !combatant.id || !combatant.actorId) { console.error(`PF2e AI Combat Assistant | FATAL ERROR: requestNextAISuggestion called with invalid combatant/actorId!`); return; } // Check actorId instead of actor object
    const actor = game.actors.get(combatant.actorId); // Fetch fresh actor object
    if (!actor) { console.error(`PF2e AI Combat Assistant | FATAL ERROR: Could not find actor with ID ${combatant.actorId}!`); return; } // Add check if actor fetch failed

    // --- Critical Check: Is it still this combatant's turn in this combat? ---
    if (game.combat?.id !== combat?.id || game.combat?.combatant?.id !== combatant.id) {
        // console.warn(`PF2e AI Combat Assistant | requestNextAISuggestion called for ${combatant.name}, but turn/combat changed. Aborting suggestion.`); // DEBUG
        await clearAITurnFlags(actor); // Clean up flags if turn ended unexpectedly (using fresh actor)
        return;
    }

    // --- Initialize or Retrieve Turn State & Calculate Initial Actions ---
    let turnState;

    if (!updatedTurnState) {
        // Initialize turn state with defaults - Action calculation moved AFTER gatherGameState
        console.log(`AI (${actor.name}): Initializing turn state (action calculation deferred).`); // DEBUG
        turnState = {
            actionsRemaining: 3, // Default, will be recalculated
            stunnedValueAtStart: 0, // Default, will be updated
            slowedValueAtStart: 0, // Default, will be updated
            currentMAP: 0,
            actionsTaken: [],
            actionsTakenDescriptions: [],
            history: [],
            manualNotes: manualNotes || '',
            lastSuggestion: null,
            lastGameState: null
        };

    } else {
        // Continue with the existing turn state passed from the previous step
        turnState = updatedTurnState;
        // Ensure condition values are carried over if they exist, otherwise default to 0
        turnState.stunnedValueAtStart = turnState.stunnedValueAtStart ?? 0;
        turnState.slowedValueAtStart = turnState.slowedValueAtStart ?? 0; // ADDED check for slowed
        // turnState.actionsLostToSlowedAtStart = turnState.actionsLostToSlowedAtStart ?? 0; // REMOVED - No longer part of turnState
        // Carry over manual notes if provided mid-turn
        if (manualNotes && manualNotes.trim() !== "") {
            turnState.manualNotes = manualNotes.trim();
        }
        console.log(`AI (${actor.name}): Continuing turn. Actions remaining: ${turnState.actionsRemaining}, MAP: ${turnState.currentMAP}`); // DEBUG
    }
    // --- End Turn State Initialization ---


    // Ensure MAP and manualNotes are present
    if (turnState.currentMAP === undefined || turnState.currentMAP === null) turnState.currentMAP = 0;
    if (turnState.manualNotes === undefined) turnState.manualNotes = ""; // Ensure manualNotes exists

    // --- Interim Results retrieval logic removed ---
    // Use the provided manual notes if available, otherwise use notes from the flag (e.g., from skipping)
    const notesForThisPrompt = manualNotes !== null ? manualNotes : turnState.manualNotes;


    // --- Check if Turn Should End ---
    if (turnState.actionsRemaining <= 0) {
        // console.log(`PF2e AI Combat Assistant | END OF TURN for ${combatant.name} (0 actions remaining).`); // DEBUG

        // --- ADDED: Gather final GameState for summary ---
        let narrativeSummary = "The turn concluded."; // Default summary
        let recentEvents = [];
        try {
            // Gather final game state to get recent events
            const gameState = await gatherGameState(combatant, combat, 0, actor);
            recentEvents = gameState?.recentEvents || [];

            // --- Generate Narrative Summary using LLM ---
            const summaryPrompt = craftTurnSummaryPrompt(combatant, turnState.actionsTakenDescriptions, recentEvents);
            // console.log("PF2e AI Combat Assistant | Turn Summary Prompt:", summaryPrompt); // DEBUG
            const apiKey = game.settings.get(MODULE_ID, 'apiKey');
            const endpoint = game.settings.get(MODULE_ID, 'llmEndpoint');
            const modelName = game.settings.get(MODULE_ID, 'aiModel');

            if (apiKey && endpoint && modelName) {
                const llmResponse = await callLLM(summaryPrompt, apiKey, endpoint, modelName);
                // Use the entire trimmed response as the narrative, assuming the prompt instructions were followed.
                if (llmResponse && llmResponse.trim()) {
                    narrativeSummary = llmResponse.trim();
                } else {
                    console.warn("PF2e AI Combat Assistant | Received empty or invalid narrative summary from LLM response:", llmResponse);
                    narrativeSummary = "The AI finished its turn, but the narrative summary was empty.";
                }
            } else {
                console.warn("PF2e AI Combat Assistant | LLM settings missing, cannot generate narrative summary.");
                narrativeSummary = "LLM settings missing; narrative summary unavailable.";
            }
            // --- End Narrative Summary Generation ---

        } catch (gatherOrLLMError) {
            console.error("PF2e AI Combat Assistant | Error during turn end summary generation:", gatherOrLLMError);
            narrativeSummary = "An error occurred while summarizing the turn.";
        }

        // Get intended actions list (still useful context)
        const actionsListHtml = turnState.actionsTakenDescriptions?.map(desc => `<li>${desc}</li>`).join('') || '<li>No actions recorded.</li>';

        // Format recent events for optional display (e.g., in GM whisper)
        const recentEventsHtml = recentEvents.length > 0
            ? recentEvents.map(event => `<li>${event}</li>`).join('')
            : '<li>No significant events recorded.</li>';

        // Construct the final message with Intended Actions first, then Narrative
        const turnCompleteContent = `
             <strong>${combatant.name}'s Turn Complete</strong><br>
             Intended Actions:<ul>${actionsListHtml}</ul>
             <p style="margin: 5px 0 5px 0; font-style: italic; border-top: 1px dashed #ccc; padding-top: 5px;">${narrativeSummary}</p>
             <details>
                 <summary style="cursor: pointer; font-size: 0.9em;">Recorded Events (GM Only)</summary>
                 <div style="padding-left: 15px; font-size: 0.9em;">
                     <ul>${recentEventsHtml}</ul>
                 </div>
             </details>
             <hr style="margin:5px 0;">
             <button class="ai-next-turn-btn" data-combatant-id="${combatant.id}" title="Advance turn (GM Only)"><i class="fas fa-arrow-right"></i> Next Turn</button>
         `;

        // Create a single message respecting the whisper settings
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken }),
            content: turnCompleteContent,
            whisper: [] // Make message public
        });


        await clearAITurnFlags(actor); // Use fresh actor
        // Notify GM if they aren't seeing player messages (redundant if whispering details)
        // if (game.user.isGM && !game.settings.get(MODULE_ID, 'showOfferToPlayers')) {
        //     ui.notifications.info(`${combatant.name}'s AI turn complete.`);
        // }
        return; // Stop processing for this actor
    }

    // --- Prepare for LLM Call ---
    // console.log(`PF2e AI Combat Assistant | Requesting suggestion for ${combatant.name} (${turnState.actionsRemaining}a left, MAP ${turnState.currentMAP}). Skipped: "${skippedAction || 'None'}". Manual Notes: "${notesForThisPrompt}"`); // DEBUG
    let thinkingMessage = null;
    try {
        thinkingMessage = await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken }),
            content: `<i>${combatant.name} (AI) thinking... (${turnState.actionsRemaining}a left, MAP ${turnState.currentMAP})</i>`,
            whisper: getWhisperRecipientsSuggestions(),
            flags: { [MODULE_ID]: { [FLAGS.TEMP_THINKING]: true } } // Flag for potential deletion
        });
    } catch (e) { /* console.warn("PF2e AI Combat Assistant | Could not create 'Thinking...' message:", e); */ } // DEBUG - Silenced

    try {
        // --- Gather Game State (includes caching strikes, conditions, effects) ---
        // Pass the *initial* turnState.actionsRemaining (likely 3) here, as gatherGameState uses it for affordability checks *before* the final action count is known.
        // The final action count will be calculated *after* this using the gathered conditions.
        let currentGameState = await gatherGameState(combatant, combat, turnState.actionsRemaining, actor); // Pass fresh actor explicitly
        if (!currentGameState || !currentGameState.self) throw new Error("Gathered game state was invalid or incomplete.");

        // --- Recalculate Actions Remaining using reliable gameState data (only if start of turn) ---
        if (!updatedTurnState) {
            console.log(`AI (${actor.name}): Recalculating start actions using gameState.`); // DEBUG
            const defaultActions = 3;
            let calculatedStartActions = defaultActions;
            const conditions = currentGameState.self.conditionsEffects || [];
            const stunned = conditions.find(c => c.name.toLowerCase().startsWith('stunned'));
            const slowed = conditions.find(c => c.name.toLowerCase().startsWith('slowed'));
            const currentStunnedValue = stunned?.value ?? 0;
            const currentSlowedValue = slowed?.value ?? 0;

            console.log(`AI (${actor.name}): Conditions from gameState - Stunned: ${currentStunnedValue}, Slowed: ${currentSlowedValue}`); // DEBUG

            // Apply the 3 - max(Stunned, Slowed) logic
            const maxConditionValue = Math.max(currentStunnedValue, currentSlowedValue);
            calculatedStartActions = Math.max(0, defaultActions - maxConditionValue);

            console.log(`AI (${actor.name}): Recalculated start actions: ${calculatedStartActions}`); // DEBUG

            // Update turnState with correct actions and condition values
            turnState.actionsRemaining = calculatedStartActions;
            turnState.stunnedValueAtStart = currentStunnedValue;
            turnState.slowedValueAtStart = currentSlowedValue;
        }
        // --- End Recalculation ---
// --- Handle 0-Action Start ---
if (turnState.actionsRemaining === 0) {
    console.log(`AI (${actor.name}): Starting turn with 0 actions due to conditions. Skipping AI suggestion.`); // DEBUG

    // Generate condition reminder HTML (using the same IIFE logic as in the normal message)
    const reminderHTML = (() => {
         const stunnedVal = turnState.stunnedValueAtStart ?? 0;
         const slowedVal = turnState.slowedValueAtStart ?? 0;
         const actorId = combatant.actorId;
         let notes = [];
         let stunnedChange = 0;
         let slowedChange = 0;
         if (stunnedVal > 0) {
             if (stunnedVal <= 3) { notes.push(`<li>Remove Stunned ${stunnedVal}.</li>`); stunnedChange = -1; }
             else { notes.push(`<li>Reduce Stunned ${stunnedVal} by 3.</li>`); stunnedChange = 3; }
         }
         if (slowedVal > 0) {
             if (slowedVal <= 3) { notes.push(`<li>Remove Slowed ${slowedVal}.</li>`); slowedChange = -1; }
             else { notes.push(`<li>Reduce Slowed ${slowedVal} by 3.</li>`); slowedChange = 3; }
         }
         if (notes.length > 0) {
             const applyButtonId = `ai-apply-cond-zero-${suggestionInstanceId}`; // Unique ID
             // Add data-end-turn="true" to signal the handler
             const applyButtonHtml = `<button id="${applyButtonId}" class="ai-apply-condition-reduction" data-actor-id="${actorId}" data-stunned-change="${stunnedChange}" data-slowed-change="${slowedChange}" data-end-turn="true" title="Apply suggested condition changes and end turn (GM Only)" style="margin-left: 10px; padding: 1px 5px; font-size: 0.9em;"><i class="fas fa-check"></i> Apply & End Turn</button>`;
             return `<div class="ai-condition-reminder" style="font-size: 0.85em; color: #800000; margin-top: 3px; padding-top: 3px; border-top: 1px dotted #aaa;">
                         <strong>Condition Reminder:</strong>
                         <div style="display: flex; align-items: center; margin-top: 2px;">
                             <ul style="margin: 0; padding-left: 20px; flex-grow: 1;">${notes.join('')}</ul>
                             ${applyButtonHtml}
                         </div>
                     </div>`;
         }
         return '';
    })();

    // Generate Retry button HTML
    const retryButtonId = `ai-retry-turn-${suggestionInstanceId}`;
    const retryButtonHtml = `<button id="${retryButtonId}" class="ai-retry-turn" data-combatant-id="${combatant.id}" title="Retry AI turn start (e.g., after correcting conditions)" style="margin-left: 5px; padding: 1px 5px; font-size: 0.9em;"><i class="fas fa-redo"></i> Retry Turn</button>`;

    // Construct the 0-action chat message
    const zeroActionContent = `
         <div style="margin-bottom: 5px;">
             <strong>${combatant.name} starts turn with 0 actions</strong> due to Stunned/Slowed conditions.
         </div>
         ${reminderHTML}
         <div style="margin-top: 5px;">
             ${retryButtonHtml}
         </div>
    `;

    // Create the chat message
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken }),
        content: zeroActionContent,
        whisper: getWhisperRecipientsSuggestions(), // Use suggestion whisper settings
        // Add flags if needed for identification, though button classes might suffice
    });

    // Clean up "Thinking..." message if it exists
    if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { });
    // Clean up flags as the turn effectively ends here unless retried
    await clearAITurnFlags(actor);
    return; // Stop further processing in this function
}
// --- End Handle 0-Action Start ---
        // Cache strikes on the actor flag after gathering state (only needed if actions > 0)
        if (currentGameState.self.strikes) {
             await actor.setFlag(MODULE_ID, FLAGS.CACHED_STRIKES, currentGameState.self.strikes); // Use fresh actor
             // console.log(`AI | Cached ${currentGameState.self.strikes.length} strikes for ${actor.name}.`); // DEBUG
        }
        // REMOVED extra closing brace from here
// REMOVING TWO EXTRA CLOSING BRACES

        // --- Craft Prompt (now includes manual notes) ---
        const prompt = craftSingleActionPrompt(combatant, currentGameState, turnState, skippedAction, notesForThisPrompt); // Removed interimResultsForPrompt
        console.groupCollapsed(`PF2e AI Combat Assistant | Prompt for ${combatant.name} (R${combat.round}.T${combat.turn})`); console.log(prompt); console.groupEnd();

        // --- Call LLM ---
        const apiKey = game.settings.get(MODULE_ID, 'apiKey'); const endpoint = game.settings.get(MODULE_ID, 'llmEndpoint'); const modelName = game.settings.get(MODULE_ID, 'aiModel');
        if (!apiKey || !endpoint || !modelName) throw new Error("LLM API Key, Endpoint, or Model Name not configured.");
        let llmResponseContent = await callLLM(prompt, apiKey, endpoint, modelName);
        if (!llmResponseContent) throw new Error("Received no valid response content from the LLM.");
        console.groupCollapsed(`PF2e AI Combat Assistant | Raw LLM Resp: ${combatant.name}`); console.debug(llmResponseContent); console.groupEnd();

        // --- Parse and Validate LLM Suggestion ---
        let parsedSuggestion = parseLLMSuggestion(llmResponseContent);
        // Handle cases where parsing fails but response has text (likely non-compliant format)
        if (!parsedSuggestion?.description) {
            if (llmResponseContent && llmResponseContent.trim().length > 0 && !llmResponseContent.toUpperCase().includes("ACTION:") && !llmResponseContent.toUpperCase().includes("COST:")) {
                parsedSuggestion = { description: llmResponseContent.trim(), cost: 1, rationale: "LLM response format unclear, assuming 1 action." }; // Default to 1 action
                // console.log("PF2e AI Combat Assistant | Using fallback parsed suggestion due to non-compliant LLM format:", parsedSuggestion); // DEBUG
            } else {
                throw new Error("LLM response could not be parsed into ACTION/COST format.");
            }
        }
        // Clean up potential escaped newlines
        parsedSuggestion.description = parsedSuggestion.description.replace(/\\n/g, ' ').trim();

        // --- Check if AI suggested a purely passive ability (unless it's also activatable) ---
        const passiveAbilityNamesLower = (currentGameState.self.passiveAbilities || []).map(p => p.name.toLowerCase().replace(' (aura)', '').trim());
        const suggestionActionMatch = parsedSuggestion.description.match(/^(?:Cast|Activate|Use|Strike:)?\s*(?:['"]?)([^:'"(]+?)\1?(?:['"]?)\s*(?:[:(]|$)/i); // Extract action name
        const suggestedActionNameLower = suggestionActionMatch?.[1]?.trim().toLowerCase();
        if (suggestedActionNameLower && passiveAbilityNamesLower.includes(suggestedActionNameLower)) {
            const activatableNamesLower = (currentGameState.self._actionsAndActionFeatsList || []).map(a => a.name.toLowerCase());
            if (!activatableNamesLower.includes(suggestedActionNameLower)) {
                // console.warn(`PF2e AI Combat Assistant | AI suggested purely passive ability "${suggestionActionMatch[1].trim()}". Requesting new suggestion.`); // DEBUG
                await requestNextAISuggestion(combatant, combat, parsedSuggestion.description, notesForThisPrompt); // Pass notes along
                if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { }); // Clean up thinking message
                return; // Stop processing this suggestion
            } else {
                // console.log(`PF2e AI Combat Assistant | Note: AI suggested "${suggestedActionNameLower}" which is passive but also appears activatable.`); // DEBUG
            }
        }

        // --- Identify Suggestion Type & Get Authoritative Cost ---
        // Pass the parsed description to identify potentially combined actions
        let identifyResult = await identifySuggestionTypeAndCost(parsedSuggestion.description, actor, currentGameState); // Use fresh actor

        // --- ADDED: Prerequisite Validation for Specific Actions ---
        let prerequisiteCheckPassed = true;
        const primaryActionName = identifyResult.actionNameForLink || identifyResult.strikeNameForButton || identifyResult.spellNameForButton || identifyResult.consumableNameForButton;

        if (primaryActionName?.toLowerCase() === 'rend') {
            // console.log(`AI Prereq Check: Validating Rend for ${actor.name}`); // DEBUG
            const rendTargetMatch = parsedSuggestion.description.match(/rend,\s*([^()]+)/i);
            const rendTargetName = rendTargetMatch?.[1]?.trim();
            const requiredStrikeType = "Claw"; // Specific to Annis Hag's Rend - might need generalization later

            if (rendTargetName) {
                const successfulStrikes = turnState.successfulStrikesThisRound || []; // ASSUMPTION: This array exists and is populated
                const relevantStrikesCount = successfulStrikes.filter(strike =>
                    strike.targetName?.toLowerCase() === rendTargetName.toLowerCase() &&
                    strike.strikeName?.toLowerCase().includes(requiredStrikeType.toLowerCase()) // Check if strike name includes "Claw"
                ).length;

                if (relevantStrikesCount < 2) {
                    prerequisiteCheckPassed = false;
                    console.warn(`PF2e AI Combat Assistant | Prerequisite Check FAILED for Rend (${actor.name} -> ${rendTargetName}). Needed 2 successful '${requiredStrikeType}' strikes, found ${relevantStrikesCount}. Requesting new suggestion.`);
                    // Request a new suggestion, skipping the failed Rend attempt
                    await requestNextAISuggestion(combatant, combat, `Rend (Failed Prereq: ${relevantStrikesCount}/${2} ${requiredStrikeType} hits)`, notesForThisPrompt, turnState); // Pass current turnState
                    if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { }); // Clean up thinking message
                    return; // Stop processing this invalid suggestion
                } else {
                    // console.log(`AI Prereq Check: Rend validation PASSED for ${actor.name} -> ${rendTargetName} (${relevantStrikesCount} relevant strikes found).`); // DEBUG
                }
            } else {
                console.warn(`PF2e AI Combat Assistant | Could not parse target name from Rend suggestion: "${parsedSuggestion.description}". Skipping prerequisite check.`); // DEBUG
            }
         } // --- ADDED: Prerequisite Validation for Grab ---
         else if (primaryActionName?.toLowerCase() === 'grab') {
             // console.log(`AI Prereq Check: Validating Grab for ${actor.name}`); // DEBUG
             const grabTargetMatch = parsedSuggestion.description.match(/grab,\s*([^()]+)/i);
             const grabTargetName = grabTargetMatch?.[1]?.trim();

             if (grabTargetName) {
                 let meetsRequirement = false;

                 // Check Req 1: A recent event was a successful Strike by this actor with Grab
                 if (Array.isArray(currentGameState?.recentEvents)) {
                     const actorName = actor.name; // Cache actor name
                     const foundSuccessfulGrabStrike = currentGameState.recentEvents.some(eventString => {
                         // Example: "Revenant: Claw -> CriticalSuccess (plus Grab)"
                         const pattern = new RegExp(`^${actorName}:.*->\\s+(Success|CriticalSuccess).*\\(plus Grab\\)`, 'i');
                         return pattern.test(eventString);
                     });

                     if (foundSuccessfulGrabStrike) {
                         meetsRequirement = true;
                         console.log(`PF2e AI Combat Assistant | Prereq Check: Grab validation PASSED (Req 1: Found recent successful Strike with Grab by ${actorName})`); // DEBUG
                     }
                 }

                 // Check Req 2: Currently Grabbing/Restraining target
                 // ASSUMPTION: gameState includes target conditions with sourceActorId
                 const targetActorData = currentGameState?.targets?.find(t => t.name?.toLowerCase() === grabTargetName.toLowerCase());
                 const isGrabbingTarget = targetActorData?.conditionsEffects?.some(cond =>
                     (cond.name.toLowerCase() === 'grabbed' || cond.name.toLowerCase() === 'restrained') &&
                     cond.sourceActorId === actor.id // ASSUMPTION: sourceActorId exists on condition
                 );
                 if (!meetsRequirement && isGrabbingTarget) {
                     meetsRequirement = true;
                     // console.log(`AI Prereq Check: Grab validation PASSED (Req 2: Currently grabbing target)`); // DEBUG
                 }

                 if (!meetsRequirement) {
                     prerequisiteCheckPassed = false;
                     console.warn(`PF2e AI Combat Assistant | Prerequisite Check FAILED for Grab (${actor.name} -> ${grabTargetName}). Neither requirement met. Requesting new suggestion.`);
                     await requestNextAISuggestion(combatant, combat, `Grab (Failed Prereqs)`, notesForThisPrompt, turnState);
                     if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { });
                     return; // Stop processing this invalid suggestion
                 }
             } else {
                 console.warn(`PF2e AI Combat Assistant | Could not parse target name from Grab suggestion: "${parsedSuggestion.description}". Skipping prerequisite check.`); // DEBUG
             }
         }
         // --- ADDED: Prerequisite Validation for Trip (using Knockdown) ---
         else if (primaryActionName?.toLowerCase() === 'trip') {
             const tripTargetMatch = parsedSuggestion.description.match(/trip,\s*([^()]+)/i); // Assuming format "Trip, Target Name"
             const tripTargetName = tripTargetMatch?.[1]?.trim();

             if (tripTargetName) {
                 let meetsRequirement = false;
                 // Check Req: A recent event was a successful Strike by this actor with Knockdown
                 if (Array.isArray(currentGameState?.recentEvents)) {
                     const actorName = actor.name;
                     const foundSuccessfulKnockdownStrike = currentGameState.recentEvents.some(eventString => {
                         const pattern = new RegExp(`^${actorName}:.*->\\s+(Success|CriticalSuccess).*\\(plus Knockdown\\)`, 'i');
                         return pattern.test(eventString);
                     });
                     if (foundSuccessfulKnockdownStrike) {
                         meetsRequirement = true;
                         console.log(`PF2e AI Combat Assistant | Prereq Check: Trip validation PASSED (Found recent successful Strike with Knockdown by ${actorName})`); // DEBUG
                     }
                 }

                 if (!meetsRequirement) {
                     prerequisiteCheckPassed = false;
                     console.warn(`PF2e AI Combat Assistant | Prerequisite Check FAILED for Trip (${actor.name} -> ${tripTargetName}). Requirement not met (No recent successful Strike + Knockdown). Requesting new suggestion.`);
                     await requestNextAISuggestion(combatant, combat, `Trip (Failed Prereqs)`, notesForThisPrompt, turnState);
                     if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { });
                     return; // Stop processing this invalid suggestion
                 }
             } else {
                 console.warn(`PF2e AI Combat Assistant | Could not parse target name from Trip suggestion: "${parsedSuggestion.description}". Skipping prerequisite check.`); // DEBUG
             }
         }
         // --- ADDED: Prerequisite Validation for Shove (using Push) ---
         else if (primaryActionName?.toLowerCase() === 'shove') {
             const shoveTargetMatch = parsedSuggestion.description.match(/shove,\s*([^()]+)/i); // Assuming format "Shove, Target Name"
             const shoveTargetName = shoveTargetMatch?.[1]?.trim();

             if (shoveTargetName) {
                 let meetsRequirement = false;
                 // Check Req: A recent event was a successful Strike by this actor with Push
                 if (Array.isArray(currentGameState?.recentEvents)) {
                     const actorName = actor.name;
                     const foundSuccessfulPushStrike = currentGameState.recentEvents.some(eventString => {
                         const pattern = new RegExp(`^${actorName}:.*->\\s+(Success|CriticalSuccess).*\\(plus Push\\)`, 'i');
                         return pattern.test(eventString);
                     });
                     if (foundSuccessfulPushStrike) {
                         meetsRequirement = true;
                         console.log(`PF2e AI Combat Assistant | Prereq Check: Shove validation PASSED (Found recent successful Strike with Push by ${actorName})`); // DEBUG
                     }
                 }

                 if (!meetsRequirement) {
                     prerequisiteCheckPassed = false;
                     console.warn(`PF2e AI Combat Assistant | Prerequisite Check FAILED for Shove (${actor.name} -> ${shoveTargetName}). Requirement not met (No recent successful Strike + Push). Requesting new suggestion.`);
                     await requestNextAISuggestion(combatant, combat, `Shove (Failed Prereqs)`, notesForThisPrompt, turnState);
                     if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { });
                     return; // Stop processing this invalid suggestion
                 }
             } else {
                 console.warn(`PF2e AI Combat Assistant | Could not parse target name from Shove suggestion: "${parsedSuggestion.description}". Skipping prerequisite check.`); // DEBUG
             }
         }
        // --- END ADDED --- (Comment updated to reflect multiple additions)

        // --- Update Description with Link & Add Stance Effect Link ---
        parsedSuggestion.description = identifyResult.modifiedDescriptionWithActionLink || parsedSuggestion.description; // Use linkified version
        if (identifyResult.isGenericActionSuggestion && identifyResult.stanceEffectUUID) {
            const effectLinkText = "(Apply Effect)";
            const effectLink = ` @UUID[${identifyResult.stanceEffectUUID}]{${effectLinkText}}`;
            parsedSuggestion.description += effectLink;
            // console.log(`PF2e AI Combat Assistant | Appended stance effect link to suggestion description.`); // DEBUG
        }
        parsedSuggestion.description = parsedSuggestion.description.trim();

        // Determine the authoritative cost, prioritizing LLM for combos
        let authoritativeCost = determineAuthoritativeCost(identifyResult, parsedSuggestion.cost);

        // --- Validate Cost vs Remaining Actions ---
        let numericCostForValidation = 0;
        if (authoritativeCost === 'R' || authoritativeCost === 'F') {
            numericCostForValidation = 0; // Reactions/Free cost 0 for validation purposes
        } else if (typeof authoritativeCost === 'string' && authoritativeCost.includes('to')) {
            numericCostForValidation = parseInt(authoritativeCost.split(' to ')[0], 10);
            if (isNaN(numericCostForValidation)) numericCostForValidation = 1;
        } else {
            numericCostForValidation = parseInt(authoritativeCost, 10);
            if (isNaN(numericCostForValidation)) numericCostForValidation = 1; // Default to 1 if cost is weird after parsing
        }
        // CRITICAL VALIDATION: Check if cost exceeds remaining actions
        // Allow 0-cost actions even if 0 actions remain (Free/Reaction)
        if (numericCostForValidation > 0 && numericCostForValidation > turnState.actionsRemaining) {
            throw new Error(`Suggested action requires ${authoritativeCost} actions (minimum ${numericCostForValidation}), but only ${turnState.actionsRemaining} remaining.`);
        }
        // Use the determined numeric cost for the confirm button
        const validatedNumericCostForButton = numericCostForValidation;


        // Clean up rationale (remove redundant action/cost lines if LLM included them)
        if (parsedSuggestion.rationale) {
            parsedSuggestion.rationale = parsedSuggestion.rationale
                .replace(/^\s*\**ACTION:\**.*$/im, '')
                .replace(/^\s*\**COST:\**.*$/im, '')
                .trim();
        }

        // --- Prepare Data for Buttons and Chat Message ---
        // Construct the full string to be encoded, NOW including the narrative
        let fullDescriptionForEncoding = parsedSuggestion.description;
        if (parsedSuggestion.rationale) {
            fullDescriptionForEncoding += ` | Rationale: ${parsedSuggestion.rationale}`;
        }
        if (parsedSuggestion.narrative) {
            fullDescriptionForEncoding += ` | NARRATIVE: ${parsedSuggestion.narrative}`; // Include narrative separator
        }
        const encodedFullDescription = encodeURIComponent(fullDescriptionForEncoding); // Encode the complete string

        const actionIconsHTML = getActionIconHTML(authoritativeCost, parsedSuggestion.description); // Get icon based on authoritative cost

        // Generate buttons, passing the NEW encoded description
        const actionButtons = generateSuggestionButtons({
            combatantId: combatant.id,
            cost: authoritativeCost, // Use the actual intended cost, not just the validation minimum
            authoritativeCostString: authoritativeCost,
            encodedDesc: encodedFullDescription, // Pass the complete encoded string
            actor: actor, // Use fresh actor
            ...identifyResult
        });
        // --- Narrative & Rationale ---
        let narrativeHTML = '';
        if (parsedSuggestion.narrative && parsedSuggestion.narrative.length > 0) {
             narrativeHTML = `<p style="margin: 8px 0 0 0; font-style: italic;">${parsedSuggestion.narrative}</p>`;
        }
        let rationaleHTML = '';
        if (parsedSuggestion.rationale && parsedSuggestion.rationale.length > 0) {
            rationaleHTML = `<p style="margin: 8px 0 0 0; padding-top: 5px; border-top: 1px dashed #ccc; font-size: 0.9em; font-style: italic;"><strong>Rationale:</strong> ${parsedSuggestion.rationale}</p>`;
        }

        // --- MAP Adjustment Controls ---
        const currentMAPDisplay = turnState.currentMAP ?? 0;
        const mapDisplayLabels = { 0: "0", 4: "-4 (Agile)", 5: "-5", 8: "-8 (Agile)", 10: "-10" };
        let mapAdjustHTML = `<div class="ai-map-adjust-controls" style="margin: 8px 0 5px 0; padding-top: 5px; border-top: 1px dashed #ccc; font-size: 0.9em;"><strong style="vertical-align: middle;">Adjust Current MAP:</strong>`;
        const mapOptions = [
            { label: mapDisplayLabels[0], value: 0, checked: currentMAPDisplay === 0 },
            { label: mapDisplayLabels[5], value: 5, checked: currentMAPDisplay === 5 || currentMAPDisplay === 4 }, // Group -4/-5 penalty
            { label: mapDisplayLabels[10], value: 10, checked: currentMAPDisplay === 10 || currentMAPDisplay === 8 } // Group -8/-10 penalty
        ];
        mapOptions.forEach(option => {
            mapAdjustHTML += `
                 <label style="margin-left: 8px; cursor: pointer;">
                     <input type="radio" name="ai-map-adjust-${combatant.id}-${suggestionInstanceId}" class="ai-map-adjust-radio"
                            data-combatant-id="${combatant.id}" data-map-value="${option.value}" ${option.checked ? 'checked' : ''}
                            title="Set MAP to ${option.label} for next AI suggestion"> ${option.label}
                 </label>`;
        });
        mapAdjustHTML += `</div>`;

        // --- Manual Notes Input Field ---
        const manualNotesHTML = `
            <div class="ai-manual-notes" style="margin: 8px 0 5px 0; padding-top: 5px; border-top: 1px dashed #ccc; font-size: 0.9em;">
                <label for="${manualInputId}" style="display: block; margin-bottom: 3px;"><strong>Manual Notes for Next Prompt:</strong> (Optional)</label>
                <input type="text" id="${manualInputId}" name="${manualInputId}" class="ai-manual-notes-input" style="width: 95%;"
                       placeholder="e.g., Focus fire on the caster, Prepare for AoE" value="${turnState.manualNotes || ''}">
            </div>`; // End manual notes div

        // Use the turnState determined at the start of the function (which is now potentially the passed-in updated state)
        const currentTurnStateForDisplay = turnState;

        const finalContent = `
             <div style="margin-bottom: 5px;">
                 ${actionIconsHTML} <strong>${parsedSuggestion.description}</strong>
                 <div class="ai-action-counter" style="font-size: 0.9em; color: #666; margin-top: 2px;">(${currentTurnStateForDisplay.actionsRemaining} actions remaining this turn)</div>
                 ${(() => {
                     const stunnedVal = currentTurnStateForDisplay.stunnedValueAtStart ?? 0;
                     const slowedVal = currentTurnStateForDisplay.slowedValueAtStart ?? 0;
                     const actorId = combatant.actorId; // Get actor ID for the button
                     let notes = [];
                     let stunnedChange = 0; // 0 = no change, -1 = remove, >0 = reduce by this amount
                     let slowedChange = 0; // 0 = no change, -1 = remove, >0 = reduce by this amount (Note: Slowed usually doesn't reduce like this, but following user request)

                     // Determine Stunned change based on user logic
                     if (stunnedVal > 0) {
                         if (stunnedVal <= 3) {
                             notes.push(`<li>Remove Stunned ${stunnedVal}.</li>`);
                             stunnedChange = -1; // Signal removal
                         } else {
                             notes.push(`<li>Reduce Stunned ${stunnedVal} by 3.</li>`);
                             stunnedChange = 3; // Signal reduction amount
                         } // <-- ADDED MISSING BRACE
                     }

                     // Determine Slowed change based on user logic
                     if (slowedVal > 0) {
                         if (slowedVal <= 3) {
                             notes.push(`<li>Remove Slowed ${slowedVal}.</li>`);
                             slowedChange = -1; // Signal removal
                         } else {
                             notes.push(`<li>Reduce Slowed ${slowedVal} by 3.</li>`);
                             slowedChange = 3; // Signal reduction amount
                         }
                     }

                     // Construct the final HTML if any notes were generated
                     if (notes.length > 0) {
                         const buttonId = `ai-apply-cond-${suggestionInstanceId}`; // Unique ID for the button
                         const buttonHtml = `<button id="${buttonId}" class="ai-apply-condition-reduction" data-actor-id="${actorId}" data-stunned-change="${stunnedChange}" data-slowed-change="${slowedChange}" title="Apply suggested condition changes (GM Only)" style="margin-left: 10px; padding: 1px 5px; font-size: 0.9em;"><i class="fas fa-check"></i> Apply</button>`;
                         // Wrap list and button in a flex container for better layout
                         return `<div class="ai-condition-reminder" style="font-size: 0.85em; color: #800000; margin-top: 3px; padding-top: 3px; border-top: 1px dotted #aaa;">
                                     <strong>Condition Reminder:</strong>
                                     <div style="display: flex; align-items: center; margin-top: 2px;">
                                         <ul style="margin: 0; padding-left: 20px; flex-grow: 1;">${notes.join('')}</ul>
                                         ${buttonHtml}
                                     </div>
                                 </div>`;
                     }

                     // Return empty string if no conditions needed reminding
                     return '';
                 })()}
             </div>
             <!-- Narrative removed from suggestion, shown on turn complete -->
             <div class="ai-suggestion-buttons" style="margin-top: 8px;">
                 ${actionButtons.primary}
             </div>
             <div class="ai-suggestion-controls" style="margin-top: 5px;">
                 ${actionButtons.secondary}
             </div>
             ${rationaleHTML}
             ${mapAdjustHTML}
             ${manualNotesHTML}
         `;

        // --- Create Suggestion Chat Message ---
        const suggestionMessageData = {
            speaker: ChatMessage.getSpeaker({ token: combatant.token || actor.prototypeToken }),
            content: finalContent,
            whisper: getWhisperRecipientsSuggestions(),
            flags: { [MODULE_ID]: { [FLAGS.OFFER_ID]: suggestionInstanceId, [FLAGS.MANUAL_NOTES_INPUT_ID]: manualInputId } } // Store IDs for later reference
        };
        await ChatMessage.create(suggestionMessageData);

        // Clean up "Thinking..." message AFTER new message is sent
        if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { });

    } catch (error) {
        console.error(`PF2e AI Combat Assistant | Error during suggestion request for ${combatant.name}:`, error);
        ui.notifications.error(`PF2e AI Combat Assistant Error: ${error.message}`);
        // Clean up flags and thinking message on error
        await clearAITurnFlags(actor); // Use fresh actor
        if (thinkingMessage?.id) await thinkingMessage.delete().catch(() => { });
    }
}


/**
 * Gathers comprehensive game state information focused on the current combatant.
 * Includes robust strike calculation considering ABP and NPC data structures.
 * MODIFIED to handle multiple prepared spell slots, aggregate ranks, and restore range sorting.
 * Filters affordability *after* collecting all spell data.
 * @param {CombatantPF2e} currentCombatant - The combatant whose turn it is.
 * @param {Combat} combat - The active combat encounter.
 * @param {number} actionsRemaining - How many actions the combatant has left.
 * @returns {Promise<object>} A structured object containing the game state for the AI prompt.
 */
async function gatherGameState(currentCombatant, combat, actionsRemaining, actorOverride = null) {
    let hasStanceAction = false;
    let hasFlourishAction = false;
    let hasAllies = false; // Flag for flanking rules
    let canSustainSpells = false; // Flag for sustain reminder
    let hasHealSpell = false; // Flag for heal guidance
    let hasGrabAttack = false; // Flag for grab reminder
    let hasLeveledSpells = false; // Flag for spell rank reminder
    let hasFreeActions = false; // Flag for free action combo reminder
    // --- START: Helper functions ---
    /**
     * Formats a spell item for inclusion in the prompt.
     * ACCEPTS an array of prepared ranks for display.
     * @param {ItemPF2e<SpellPF2e>} spell - The base spell item.
     * @param {number[]|null} [preparedRankArray=null] - Array of ranks this spell is prepared in.
     * @param {string|null} [fromText=null] - Optional text indicating the source (e.g., "(from Item Name)").
     * @returns {object} Formatted spell data for the prompt.
     */
    // AFTER (Correctly uses spell.system.level.value and stores it)
    const formatSpellForPrompt = (spell, preparedRankArray = null, fromText = null) => {
        if (!spell || !spell.system) return {};
        const cost = parseActionCostValue(spell.system.time?.value, spell.system.actions?.value, spell.system.description?.value, spell.system.actionType?.value);
        const costText = formatParsedCostToDisplay(cost);
        const baseLevel = spell.system.level?.value ?? 1; // <-- Get intrinsic base level

        // Only summarize description if it's not already empty/null
        const fullDesc = spell.system.description?.value ? summarizeAbilityDetails(spell.system.description.value) : '';
        const details = _extractSpellDetails(spell);
        const numericRange = getNumericRange(spell, 'gatherGameState-spell');

        // --- Rank Display Logic (Aggregated & Refined) ---
        let rankDisplay = '';
        // Use spell.rank (likely heightened) for the main display for focus/spontaneous
        const displayRank = spell.rank || baseLevel; // Fallback to baseLevel if rank is missing

        if (spell.isCantrip) {
            rankDisplay = 'Cantrip';
        } else if (spell.isFocusSpell) {
            // Show Focus R<EffectiveRank>
            rankDisplay = `Focus R${displayRank}`; // <-- Use potentially heightened rank
        } else if (preparedRankArray && preparedRankArray.length > 0) {
            // Prepared spells show available slots
            preparedRankArray.sort((a, b) => a - b);
            const rankCounts = preparedRankArray.reduce((acc, rank) => {
                acc[rank] = (acc[rank] || 0) + 1;
                return acc;
            }, {});
            const prepString = Object.entries(rankCounts)
                .map(([rank, count]) => `R${rank}${count > 1 ? `x${count}` : ''}`)
                .join(', ');
            rankDisplay = `(Prepared Slots: ${prepString})`;
        } else {
            // Default for others (spontaneous, item) - show potentially heightened rank
            rankDisplay = `R${displayRank}`; // <-- Use potentially heightened rank
        }
        // --- END Rank Display Logic ---

        return {
            name: spell.name,
            uuid: spell.uuid,
            id: spell.id,
            entryId: spell.system.location?.value,
            baseLevel: baseLevel, // <-- Store the correct baseLevel
            rank: spell.rank, // Keep potentially heightened rank for other logic? (Maybe remove if unused)
            costText: costText,
            costValue: cost, // Store parsed cost value
            range: details.range,
            targets: details.targets,
            defense: details.defense,
            duration: details.duration,
            area: details.area,
            traitsString: details.traitsString,
            fullDesc: fullDesc,
            numericRange: numericRange,
            fromText: fromText || '',
            rankDisplay: rankDisplay, // The final display string using correct base level where needed
            isCantrip: spell.isCantrip, // Store type for final list separation
            isFocusSpell: spell.isFocusSpell, // Store type for final list separation
            system: spell.system // Keep system data temporarily for affordability check later
        };
    };

    // Helper to format item-granted spells
    const formatItemSpellForPrompt = (spell, actor) => {
        if (!spell || !spell.system) return {};
        const grantingItem = actor?.items.find(item => item.system.description?.value?.includes(spell.uuid));
        const fromText = grantingItem ? ` (from ${grantingItem.name})` : ' (from Item)';
        return formatSpellForPrompt(spell, null, fromText);
    };

    // Helper to format Conditions/Effects
    const formatConditionOrEffect = (item, includeDescription = true) => { // Add includeDescription parameter
        if (!item || !item.system) return null;
        let name = item.name;
        const value = item.system.value?.value ?? null; // Extract value if it exists
        const slug = item.slug || name.slugify(); // Get slug for reliable check

        // If Grabbed, explicitly add implied conditions to the name for the prompt
        // We will add the descriptions below if includeDescription is true
        if (slug === 'grabbed' && !includeDescription) {
             name += " (implies Off-Guard, Immobilized)";
        }

        if (includeDescription) {
            let desc = summarizeAbilityDetails(item.system.description?.value) || "No description available.";

            // If Grabbed, fetch and append descriptions for Off-Guard and Immobilized
            if (slug === 'grabbed') {
                name += " (implies Off-Guard, Immobilized)"; // Add to name here too for clarity
                try {
                    // Fetch Off-Guard condition object using ConditionManager
                    const offGuardCondition = game.pf2e.ConditionManager.getCondition('off-guard');
                    if (offGuardCondition?.description) {
                        const offGuardDescClean = summarizeAbilityDetails(offGuardCondition.description);
                        desc += `\n\n--- Implied: Off-Guard ---\n${offGuardDescClean}`;
                    } else {
                        desc += `\n\n--- Implied: Off-Guard ---\n(Description lookup failed)`;
                        console.warn("AI: Failed to find Off-Guard condition via ConditionManager or it lacked a description.");
                    }

                    // Fetch Immobilized condition object using ConditionManager
                    const immobilizedCondition = game.pf2e.ConditionManager.getCondition('immobilized');
                    if (immobilizedCondition?.description) {
                        const immobilizedDescClean = summarizeAbilityDetails(immobilizedCondition.description);
                        desc += `\n\n--- Implied: Immobilized ---\n${immobilizedDescClean}`;
                    } else {
                        desc += `\n\n--- Implied: Immobilized ---\n(Description lookup failed)`;
                        console.warn("AI: Failed to find Immobilized condition via ConditionManager or it lacked a description.");
                    }
                } catch (e) {
                    console.error("AI Error fetching/processing implied condition descriptions via ConditionManager:", e);
                    desc += "\n\n(Error fetching implied condition descriptions)";
                }
            }
            // Return name (potentially modified), value, and description (potentially augmented)
            return { name: name, value: value, desc: desc };
        } else {
            // Return only name (potentially modified) and value if description is excluded
            return { name: name, value: value };
        }
    };
    // Removed extra closing brace that caused syntax error
    // --- END: Helper functions ---

    // console.log(`PF2e AI Combat Assistant | --- Gathering Game State for ${currentCombatant?.name ?? 'Unknown'} (Actions Remaining: ${actionsRemaining}) ---`); // DEBUG
    const actor = actorOverride || currentCombatant?.actor; // Use override if provided, else fallback
    const scene = combat?.scene;
    const grid = canvas?.grid;

    if (!actor) { console.error(`AI GatherState Error: No actor found for combatant ${currentCombatant?.id}!`); return {}; }
    if (!combat) { console.error(`AI GatherState Error: No combat object provided!`); return {}; }
    if (!scene) { /* console.warn(`AI GatherState Warning: No scene object found...`); */ } // DEBUG - Silenced
    if (!canvas?.ready || !canvas.tokens?.active || !grid?.size || !grid.distance) { console.error(`AI GatherState Error: Canvas/Grid not ready...`); return {}; }

    const selfCanvasToken = canvas.tokens.get(currentCombatant.tokenId);
    const selfTokenDocument = selfCanvasToken?.document;
    const selfTokenCenter = selfCanvasToken?.center;
    const selfCoordinates = selfCanvasToken ? { x: Math.round(selfCanvasToken.x), y: Math.round(selfCanvasToken.y) } : null;

    if (!selfCanvasToken || !selfTokenDocument || !selfTokenCenter) { console.error(`AI GatherState Error: Failed to get canvas token/document/center for self: ${currentCombatant.name}...`); return {}; }

    const designations = combat.getFlag(MODULE_ID, FLAGS.DESIGNATIONS) || {};
    const selfDesignation = designations[currentCombatant.id] || 'enemy';

    const isABPActive = game.settings.get("pf2e", "automaticBonusVariant") !== "noABP";
    const abpMode = isABPActive ? game.settings.get("pf2e", "automaticBonusVariant") : "noABP";
    const maxSpellRank = CONFIG.PF2E?.spellLevels ?? 10; // Max spell rank constant

    // --- Intermediate Spell Map ---
    // Key: Underlying Spell Identifier (SourceID or Slug), Value: { baseSpellItem: ItemPF2e, preparedRanks: number[], sources: Set<string>, isItemGranted: boolean }
    const spellMap = new Map();

    // --- DEFINE collectedSpells EARLY ---
    const collectedSpells = { leveled: [], focus: [], cantrips: [], item: [] };

    // --- Item Granted Spells (Process into Map using Compendium UUID as key - SKIP FEATS) ---
    try {
        for (const item of actor.items) {
            // --- MODIFICATION: Skip 'feat' type items entirely in this loop ---
            if (item.type === 'feat') continue;
            // --- END MODIFICATION ---

            if (!['equipment', 'action', 'consumable', 'weapon', 'armor', 'shield'].includes(item.type) || !item.system.description?.value) continue; // Removed 'feat' from includes check

            const uuidRegex = /@UUID\[(Compendium\.pf2e\.spells-srd\.Item\.[a-zA-Z0-9]+)\]\{[^}]*\}/g; // Only look for spells-srd
            let match;
            while ((match = uuidRegex.exec(item.system.description.value)) !== null) {
                const foundUuid = match[1];
                const mapKey = foundUuid;

                if (!spellMap.has(mapKey)) {
                    try {
                        const potentialSpell = await fromUuid(foundUuid);
                        // Check affordability AND ensure it's not a focus spell (those belong to entries)
                        if (potentialSpell && potentialSpell.type === 'spell' && !potentialSpell.isFocusSpell) {
                            const grantingItemName = item.name || 'Unknown Item';
                            spellMap.set(mapKey, {
                                baseSpellItem: potentialSpell,
                                preparedRanks: [],
                                sources: new Set([`Item (${grantingItemName})`]),
                                isItemGranted: true
                            });
                            // console.log(`AI GatherState: Added item-granted spell ${potentialSpell.name} (${mapKey}) to map.`); // DEBUG
                        }
                    } catch (resolveError) { /* Ignore */ }
                } else {
                    // If already in map (e.g. from another item), just add source if different
                    const existingData = spellMap.get(mapKey);
                    const newSource = `Item (${item.name || 'Unknown Item'})`;
                    if (!existingData.sources.has(newSource)) {
                        existingData.sources.add(newSource);
                        existingData.isItemGranted = true; // Ensure it's marked as item granted
                    }
                }
            }
        }
    } catch (itemLoopError) { console.error("AI | Error processing items for granted spells:", itemLoopError); }


    // --- Process Actor Spellcasting Entries ---
    if (actor.spellcasting) {
        for (const entry of actor.spellcasting) {
            if (!entry.system || !entry.spells) continue;

            // Iterate through all spells known by the entry first
            for (const baseSpell of entry.spells) {

                if (!baseSpell || !baseSpell.id) continue; // Need item ID for prepared slots // <<< REMOVED AFFORDABILITY CHECK

                const sourceId = baseSpell.sourceId; // Compendium link if available
                const slug = baseSpell.system?.slug || baseSpell.name.slugify();
                const mapKey = sourceId || `slug:${slug}`; // Prioritize SourceID, fallback to slug

                // Add base spell item to map if key not present
                if (!spellMap.has(mapKey)) { // <<< USES mapKey
                    spellMap.set(mapKey, { // <<< USES mapKey
                        baseSpellItem: baseSpell,
                        preparedRanks: [],
                        sources: new Set([`Entry (${entry.name})`]),
                        isItemGranted: false // Initially assume not item-granted unless updated later
                    });
                } else {
                    // If key exists, add this entry as a source
                    spellMap.get(mapKey).sources.add(`Entry (${entry.name})`);
                }
            }

            if (entry.isPrepared) {
                for (let rank = 0; rank <= maxSpellRank; rank++) {
                    const slotKey = `slot${rank}`;
                    const slotData = entry.system.slots?.[slotKey];
                    if (!slotData?.prepared) continue;

                    for (const preparedSlot of slotData.prepared) {
                        if (preparedSlot && !preparedSlot.expended) {
                            const spellId = preparedSlot.id; // Actor's Item ID
                            if (!spellId) continue;
                            const baseSpellItem = actor.items.get(spellId); // Get item by ID
                            if (baseSpellItem) {
                                const sourceId = baseSpellItem.sourceId;
                                const slug = baseSpellItem.system?.slug || baseSpellItem.name.slugify();
                                const mapKey = sourceId || `slug:${slug}`; // <<< USE mapKey

                                if (spellMap.has(mapKey)) { // <<< CHECKS mapKey
                                    spellMap.get(mapKey).preparedRanks.push(rank);
                                } else {
                                    // This log indicates a spell is prepared but wasn't found during the initial entry scan - might be an issue.
                                    // console.warn(`AI GatherState: Prepared spell ${baseSpellItem?.name ?? spellId} (Rank ${rank}) found, but its key '${mapKey}' wasn't in spellMap initially.`); // DEBUG
                                    // Don't add late here to avoid potential formatting issues
                                }
                            } else { /* console.warn(`AI GatherState: Could not find base spell item for prepared ID ${spellId}`); */ } // DEBUG - Silenced
                        }
                    }
                }
            }
        }
    }

    // --- Finalize Spell Lists from Map (WITH Affordability Check) ---
    const affordabilityCheck = (item) => { // Defined helper here
        const cost = parseActionCostValue(item.system.time?.value, item.system.actions?.value, item.system.description?.value, item.system.actionType?.value);
        let minCost = 99;
        if (cost === 'R' || cost === 'F' || cost === 0) { minCost = 0; }
        else if (typeof cost === 'string' && cost.includes(' to ')) {
            const parts = cost.split(' to ');
            if (parts.length === 2) { minCost = parseInt(parts[0], 10); }
        } else if (Number.isInteger(cost)) { minCost = cost; }
        if (isNaN(minCost)) { minCost = 99; }
        const affordable = minCost <= actionsRemaining;
        return affordable;
    };

    console.log(`--- AI GatherState: Finalizing Spells from Map (Actions Remaining: ${actionsRemaining}) ---`); // Log start

    for (const [mapKey, data] of spellMap.entries()) { // <<< Iterates by mapKey
        let { baseSpellItem, preparedRanks, sources, isItemGranted } = data; // <<< Destructure baseSpellItem
        if (!baseSpellItem) {
            console.log(`   Skipping mapKey ${mapKey}: Missing baseSpellItem.`);
            continue;
        }

        // Format the spell using collected ranks
        const formattedSpell = formatSpellForPrompt(baseSpellItem, preparedRanks.length > 0 ? preparedRanks : null, null); // Formatting before affordability

        // Check affordability based on the *original* baseSpellItem's cost
        const affordable = affordabilityCheck(baseSpellItem); // Pass original item

        if (!affordable) {
            console.log(`   Skipping ${baseSpellItem.name} (mapKey ${mapKey}): Not affordable (Cost: ${formattedSpell.costValue}, Actions Left: ${actionsRemaining})`);
            continue; // *** Skip if not affordable ***
        }

        console.log(`   Processing ${formattedSpell.name} (mapKey ${mapKey}): Affordable. Type Check: Item=${isItemGranted}, Focus=${formattedSpell.isFocusSpell}, Cantrip=${formattedSpell.isCantrip}`);
 
        // *** ADD COOLDOWN CHECK HERE ***
        const frequency = baseSpellItem.system.frequency;
        if (frequency && frequency.per && frequency.max > 0) { // Check if it has a limited frequency
            if (isAbilityOnCooldown(actor, baseSpellItem)) {
                console.log(`   Skipping ${baseSpellItem.name} (mapKey ${mapKey}): On Cooldown.`);
                continue; // Skip this spell if it's on cooldown
            }
        }
        // *** END COOLDOWN CHECK ***
 
        // *** Check for Stance/Flourish/Heal/Sustain ***
        const spellTraits = baseSpellItem.system?.traits?.value || [];
        if (spellTraits.includes('stance')) hasStanceAction = true;
        if (spellTraits.includes('flourish')) hasFlourishAction = true;
        if (baseSpellItem.name === 'Heal') hasHealSpell = true;
        if (baseSpellItem.system?.duration?.value?.includes('sustained')) canSustainSpells = true;
        // *** END Checks ***

        // *** Check for Free Action Cost ***
        if (formattedSpell.costValue === 'F' || formattedSpell.costValue === 0) {
            hasFreeActions = true;
        }
        // *** END Free Action Check ***

        // Determine primary source text (needed if added)
        const sourceText = isItemGranted ? `(from ${Array.from(sources).find(s => s.startsWith("Item"))?.replace(/^Item \(/, '').replace(/\)$/, '') || 'Item'})` : null;
        // Re-format with source text if it will be added
        const finalFormattedSpell = formatSpellForPrompt(baseSpellItem, preparedRanks.length > 0 ? preparedRanks : null, sourceText);


        // Assign to final lists based on type and source priority
        if (isItemGranted) { // Prioritize adding to item list
            console.log(`      > Adding ${finalFormattedSpell.name} to Item list.`);
            collectedSpells.item.push(finalFormattedSpell);
        } else if (finalFormattedSpell.isFocusSpell) {
            if ((actor.system.resources?.focus?.value ?? 0) > 0) {
                console.log(`      > Adding ${finalFormattedSpell.name} to Focus list.`);
                collectedSpells.focus.push(finalFormattedSpell);
            } else {
                console.log(`      > Skipping Focus spell ${finalFormattedSpell.name}: No focus points.`);
            }
        } else if (finalFormattedSpell.isCantrip) {
            console.log(`      > Adding ${finalFormattedSpell.name} to Cantrip list.`);
            collectedSpells.cantrips.push(finalFormattedSpell);
        } else { // *** This is where leveled spells should go ***
            console.log(`      > Checking ${finalFormattedSpell.name} for Leveled list... Prepared Ranks: [${preparedRanks.join(',')}]`);
            const entrySource = Array.from(sources).find(s => s.startsWith("Entry"));
            const entryName = entrySource?.match(/Entry \(([^)]+)\)/)?.[1];
            const spellcastingEntry = entryName ? actor.spellcasting.find(e => e.name === entryName) : null;
            console.log(`         Entry Source: ${entrySource || 'None'}, Entry Name: ${entryName || 'None'}, Found Entry: ${!!spellcastingEntry}, Is Prepared Entry: ${spellcastingEntry?.isPrepared ?? 'N/A'}`);

            // Check if prepared ranks exist OR if source entry is not prepared (e.g., spontaneous)
            if (preparedRanks.length > 0 || (spellcastingEntry && !spellcastingEntry.isPrepared)) {
                console.log(`         >> Adding ${finalFormattedSpell.name} to Leveled list.`);
                collectedSpells.leveled.push(finalFormattedSpell); // *** Add to leveled list ***
                hasLeveledSpells = true; // Set the flag since we found a leveled spell
            } else {
                // This log indicates a spell wasn't item/focus/cantrip and wasn't prepared/spontaneous
                // console.warn(`AI GatherState: Spell ${finalFormattedSpell.name} skipped categorization (not item/focus/cantrip, and not prepared/spontaneous?). Sources: ${Array.from(sources).join(', ')}`); // DEBUG
            }
        }
    } // End loop

    console.log(`--- AI GatherState: Finished Finalizing Spells. Found ${collectedSpells.leveled.length} leveled spells. ---`); // Log end


    // --- Restore Original Range Sorting ---
    const sortSpellsForPrompt = (a, b) => {
        const aIsSelf = a.numericRange === 0;
        const bIsSelf = b.numericRange === 0;

        // Prioritize Self (0 range) spells
        if (aIsSelf && !bIsSelf) return -1; // a (Self) comes before b (Not Self)
        if (!aIsSelf && bIsSelf) return 1;  // b (Self) comes before a (Not Self)
        if (aIsSelf && bIsSelf) return a.name.localeCompare(b.name); // Both Self, sort alphabetically

        // If neither is Self, sort by descending range
        if (b.numericRange !== a.numericRange) {
            return b.numericRange - a.numericRange;
        }

        // If ranges are equal (and not 0), sort alphabetically
        return a.name.localeCompare(b.name);
    };

    collectedSpells.leveled.sort(sortSpellsForPrompt);
    collectedSpells.focus.sort(sortSpellsForPrompt);
    collectedSpells.cantrips.sort(sortSpellsForPrompt);
    collectedSpells.item.sort(sortSpellsForPrompt);

    // --- Actions, Feats, Passive Abilities ---
    const activatableActionsAndFeats = [];
    const comboSetupActions = []; // Added list for combo setup actions
    const passiveAbilities = [];
    const FILTER_KEYWORDS = ["proficiency", "expert", "master", "legendary", "you gain your choice", "skill", "you gain the", "minute", "You gain a", "anathema", "You are a spellcaster", "You gain the", "success instead", "initiative"];
    const processItem = async (item, itemType) => { // Added async

        try {
            const name = item.name;
            // Check 1: Specific feat slug filter
            if (item.system?.slug === 'initiate-warden' || item.system?.slug === 'advanced-warden') {
                return;
            }

            // --- Get Description: Prioritize Self-Effect for Feats ---
            let descriptionSource = item.system.description?.value || ""; // Default to item description
            if (item.type === 'feat' && item.system?.selfEffect?.uuid) {
                try {
                    const effect = await fromUuid(item.system.selfEffect.uuid);
                    if (effect && effect.system?.description?.value) {
                        // console.log(`AI processItem: Using description from effect "${effect.name}" for feat "${item.name}"`); // DEBUG
                        descriptionSource = effect.system.description.value;
                    } else {
                        // console.warn(`AI processItem: Feat "${item.name}" has selfEffect UUID "${item.system.selfEffect.uuid}" but effect not found or has no description. Falling back to feat description.`); // DEBUG
                    }
                } catch (err) {
                    console.error(`AI processItem: Error fetching effect for feat "${item.name}" (UUID: ${item.system.selfEffect.uuid}):`, err);
                    // Fallback already handled by default descriptionSource
                }
            }
            let descriptionBeforeSummarize = descriptionSource;
            // --- End Get Description ---
            let fullDesc = summarizeAbilityDetails(descriptionBeforeSummarize);

            const nameLower = name.toLowerCase();
            const descLower = fullDesc.toLowerCase();

            // Check 2: Keyword filter for name and description
            const keywordFound = FILTER_KEYWORDS.some(keyword => nameLower.includes(keyword.toLowerCase()) || descLower.includes(keyword.toLowerCase()));
            if (keywordFound) {
            // Removed duplicate if statement here
                return; // Skip this item if a filter keyword is found
            }

            const traits = item.system.traits?.value || [];
            const frequency = item.system.frequency; // Get frequency data

            // *** ADD COOLDOWN CHECK HERE ***
            if (frequency && frequency.per && frequency.max > 0) { // Check if it has a limited frequency
                if (isAbilityOnCooldown(actor, item)) {
                    // console.log(`AI processItem: Skipping "${name}" because it's on cooldown.`); // DEBUG
                    return; // Skip this item entirely if on cooldown
                }
            }
            // *** END COOLDOWN CHECK ***
 
            // *** Check for Stance/Flourish Traits (Actions/Feats) ***
            if (traits.includes('stance')) hasStanceAction = true;
            if (traits.includes('flourish')) hasFlourishAction = true;
            // *** END Trait Check ***
 
            const actionTypeValue = item.system.actionType?.value;
            const timeValue = item.system.time?.value;
            const actionsValue = item.system.actions?.value;
            const parsedCost = parseActionCostValue(timeValue, actionsValue, item.system.description?.value, actionTypeValue);
            const isPassive = (actionTypeValue === 'passive' && parsedCost !== 'F' && parsedCost !== 0);

            if (isPassive) {
                const isAura = traits.includes('aura'); const hasAuraRule = item.system.rules?.some(rule => rule.key === "Aura"); const displayName = (isAura || hasAuraRule) ? `${name} (Aura)` : name;
                passiveAbilities.push({ name: displayName, traits: traits.join(', ') || '', fullDesc: fullDesc }); // Use fullDesc here
                // Removed previous log here, new log added before isPassive check
            } else {
                const costText = formatParsedCostToDisplay(parsedCost);
                const includesStrike = /\b(?:make|perform|attempt)s? (?:a|an|one|your) Strike\b/i.test(fullDesc || "");

                const isActionAffordableCheck = (actionItem) => {
                    // Recalculate cost for accuracy inside affordability check
                    const checkCostValue = parseActionCostValue(actionItem.system.time?.value, actionItem.system.actions?.value, actionItem.system.description?.value, actionItem.system.actionType?.value);
                    // Determine the cost to use *for the affordability check*. Assume 1 if parsing failed.
                    const costForCheck = (checkCostValue === null) ? 1 : checkCostValue;
                    // Calculate the minimum numerical cost required based on the costForCheck
                    let minActionCost = 99; // Default to unaffordable
                    if (costForCheck === 'R' || costForCheck === 'F' || costForCheck === 0) {
                        minActionCost = 0;
                    } else if (typeof costForCheck === 'string' && costForCheck.includes(' to ')) {
                        const parsedMin = parseInt(costForCheck.split(' to ')[0], 10);
                        if (!isNaN(parsedMin)) minActionCost = parsedMin;
                    } else if (Number.isInteger(costForCheck)) {
                        minActionCost = costForCheck;
                    }
                    // Final safety check for NaN
                    if (isNaN(minActionCost)) minActionCost = 99;
                    // Return affordability based on minActionCost, but include the original checkCostValue
                    return { affordable: minActionCost <= actionsRemaining, cost: checkCostValue, minCost: minActionCost };
                };

                const affordabilityResult = isActionAffordableCheck(item);

                if (affordabilityResult.affordable) {
                    let frequencyText = '';
                    if (frequency?.max && frequency?.per) {
                        const isUsed = (frequency.value ?? 0) >= frequency.max;
                        frequencyText = `(Frequency: ${frequency.value ?? 0}/${frequency.max} per ${frequency.per})`;
                    }
                    // *** Check for Free Action Cost ***
                    if (parsedCost === 'F' || parsedCost === 0) {
                        hasFreeActions = true;
                    }
                    // *** END Free Action Check ***
// Check for combo setup pattern (Generalized Regex v2)
const comboSetupRegex = /If your next action is to (.*?)(?:,\s*(?:you|they|that spell|reduce|select|spend|gain|roll|target)\b|\.(?!\s*A creature)|\.$)/i;
const comboSetupMatch = fullDesc.match(comboSetupRegex);
const isComboSetup = !!comboSetupMatch;
const followUpAction = isComboSetup ? comboSetupMatch[1].trim() : null;
// DEBUG: Log combo check
// console.log(`AI Combo Check: Item "${name}", Regex Test: ${comboSetupRegex.test(fullDesc)}, Match: ${comboSetupMatch}, IsCombo: ${isComboSetup}, FollowUp: ${followUpAction}`); // DEBUG

                    const dataToPush = {
                        name: name, slug: item.system.slug || name.slugify(), costText: costText, costValue: parsedCost,
                        traits: traits.join(', ') || '', fullDesc: fullDesc,
                        includesStrike: includesStrike,
                        frequencyText: frequencyText,
                        uuid: item.uuid,
                        numericRange: getNumericRange(item, 'gatherGameState-action'),
                        followUpAction: followUpAction // Add follow-up action if applicable
                    };

                    if (isComboSetup) {
                        // DEBUG: Log adding to combo list
                        // console.log(`AI Combo Add: Adding "${name}" to comboSetupActions list.`); // DEBUG
                        comboSetupActions.push(dataToPush); // Add to combo setup list
                    } else {
                        activatableActionsAndFeats.push(dataToPush); // Add to regular activatable list
                    }
                }
            } // End of else block (for non-passive items)
        } // Added missing closing brace for try block
        catch (error) { console.error(`AI processItem: Error processing item "${item?.name}" (ID: ${item?.id}, Type: ${itemType}):`, error); }
    };

    console.log(`--- AI gatherGameState: Processing Actor Actions...`); // Log start of loop
    for (const item of actor.itemTypes.action) {
        await processItem(item, 'action');
    }
    console.log(`--- AI gatherGameState: Finished Actor Actions.`); // Log end of loop

    // +++ DEBUG LOG 4: Log the final list before sorting +++
    console.log('--- AI gatherGameState: Activatable Actions/Feats BEFORE SORT:', activatableActionsAndFeats.map(a => a.name));


    console.log(`--- AI gatherGameState: Processing Actor Feats...`); // Log start of loop
    for (const item of actor.itemTypes.feat) {
        const nameLower = item.name.toLowerCase();
        const descLower = summarizeAbilityDetails(item.system.description?.value).toLowerCase();
        if ((item.system.traits?.value?.includes('classfeature') || item.system.traits?.value?.includes('archetype')) &&
            (nameLower.includes('spellcast') || descLower.includes('spellcast') || nameLower.includes('spell repertoire') || nameLower.includes('focus spell') || nameLower.includes('cantrip expansion'))) {
            continue; // Use continue for for...of loop instead of return
        }
        await processItem(item, 'feat');
    }
    console.log(`--- AI gatherGameState: Finished Actor Feats.`); // Log end of loop

    // Sort Actions/Feats like spells/items
    activatableActionsAndFeats.sort(sortSpellsForPrompt); // Use the same sorting logic

    // +++ DEBUG LOG 5: Log the final list AFTER sorting +++
    console.log('--- AI gatherGameState: Activatable Actions/Feats AFTER SORT:', activatableActionsAndFeats.map(a => a.name));

    // --- Other Combatants Info ---
    const otherCombatantsInfoRaw = combat.combatants
        .filter(c => c.id !== currentCombatant.id && c.actor)
        .map(otherCombatant => {
            const otherActor = otherCombatant.actor;
            const otherCanvasToken = canvas.tokens.get(otherCombatant.tokenId);
            const otherTokenCenter = otherCanvasToken?.center;
            const otherCoordinates = otherCanvasToken ? { x: Math.round(otherCanvasToken.x), y: Math.round(otherCanvasToken.y) } : null;
            let canSee = false; let distanceString = null; let numericDistance = Infinity; let positionString = 'Unknown Position';

            // Ensure both tokens exist on the canvas before checking LoS or distance
            if (selfCanvasToken && otherCanvasToken) {
                try {
                    // --- Line of Sight Check (uses centers, which is generally acceptable for LoS) ---
                    if (selfTokenCenter && otherTokenCenter) {
                        canSee = !CONFIG.Canvas.polygonBackends.sight.testCollision(selfTokenCenter, otherTokenCenter, { type: "sight", mode: "any" });
                    } else {
                        canSee = false; // Cannot determine LoS without centers
                        positionString = otherCanvasToken ? 'Unknown (Missing Center?)' : 'Token Not Found'; // Update position string
                    }

                    // --- Distance Calculation (REVISED to use token.distanceTo) ---
                    if (canSee) {
                        const gridUnitsLabel = grid.units || 'ft';
                        try {
                            // Use token.distanceTo for grid-aware, size-aware distance measurement (returns feet)
                            numericDistance = selfCanvasToken.distanceTo(otherCanvasToken);

                            // Ensure distance is non-negative
                            numericDistance = Math.max(0, numericDistance);

                            // Format the string
                            distanceString = `${numericDistance} ${gridUnitsLabel}`;
                            positionString = otherCoordinates ? `Pos: (${otherCoordinates.x}, ${otherCoordinates.y})` : 'Position Unknown';

                        } catch (measureError) {
                            distanceString = "Visible (Dist Calc Error)";
                            numericDistance = Infinity; // Set numeric distance to infinity on error
                            if (otherCanvasToken) positionString = `approx. (${Math.round(otherCanvasToken.x)}, ${Math.round(otherCanvasToken.y)}) (Dist Calc Error)`;
                            // console.warn(`AI Distance measure failed between ${currentCombatant.name} and ${otherCombatant.name}:`, measureError); // DEBUG
                        }
                    } else { // If cannot see
                        positionString = 'Hidden / Out of Sight';
                        numericDistance = Infinity; // Treat as infinite distance if not visible
                        distanceString = null; // No distance string if not visible
                    }

                } catch (losError) {
                    // Handle errors during LoS check
                    canSee = false;
                    positionString = 'Error Checking Visibility';
                    numericDistance = Infinity;
                    distanceString = null;
                    // console.warn(`AI LoS check failed between ${currentCombatant.name} and ${otherCombatant.name}:`, losError); // DEBUG
                }
            } else { // One or both tokens not found on canvas
                positionString = selfCanvasToken ? 'Target Token Not Found' : 'Self Token Not Found'; // More specific message
                numericDistance = Infinity;
                distanceString = null;
                canSee = false; // Cannot see if a token is missing
            }

            // --- Rest of the data gathering for the combatant ---
            const targetDesignation = designations[otherCombatant.id] || 'enemy';
            const relation = (selfDesignation === targetDesignation) ? 'friendly' : 'enemy';
            const hpData = otherActor?.system?.attributes?.hp;
            let hpPercent = null;
            // Calculate HP percentage only if visible and HP data exists
            if (canSee && hpData) {
                hpPercent = (hpData.max > 0) ? Math.round((hpData.value / hpData.max) * 100) : (hpData.value > 0 ? 1 : 0);
            }
            // Gather conditions/effects only if visible
            let targetConditionsEffects = [];
            if (canSee && otherActor) {
                try {
                    if (otherActor.itemTypes?.condition?.length > 0) { // Use .length for Array
                        targetConditionsEffects.push(...otherActor.itemTypes.condition.map(item => formatConditionOrEffect(item, false)).filter(item => item !== null)); // Pass false
                    }
                    if (otherActor.itemTypes?.effect?.length > 0) { // Use .length for Array
                        targetConditionsEffects.push(...otherActor.itemTypes.effect.map(item => formatConditionOrEffect(item, false)).filter(item => item !== null)); // Pass false
                    }
                } catch (condError) {
                    // console.warn(`AI GatherState: Error formatting conditions/effects for ${otherCombatant.name}:`, condError); // DEBUG
                }
            }
            // Get size only if visible
            const size = canSee ? (otherActor?.size || '?') : null;

            return {
                id: otherCombatant.id,
                name: otherCombatant.name || 'Unknown',
                relation: relation,
                positionString: positionString,
                coordinates: otherCoordinates,
                distance: distanceString, // This might be null if not visible
                numericDistance: numericDistance, // Will be Infinity if not visible or error
                hpPercent: hpPercent, // Will be null if not visible
                defeated: otherActor?.isDefeated ?? false,
                conditionsEffects: targetConditionsEffects, // Will be empty if not visible
                size: size // Will be null if not visible
            };
        });

    // ADDED SAFETY CHECK for relation error
    const allies = []; const enemies = [];
    otherCombatantsInfoRaw.forEach(info => {
        if (!info) {
            console.warn("AI GatherState: Skipping invalid combatant entry in otherCombatantsInfoRaw.");
            return;
        }
        if (info.relation === 'friendly') {
            allies.push(info); // Always include allies, even if defeated
        } else if (info.relation === 'enemy' && !info.defeated) { // Only include enemies if they are NOT defeated
            enemies.push(info);
        } else if (info.relation !== 'friendly' && info.defeated) {
            // Optionally log or handle defeated enemies if needed, but don't add them to the list for the prompt
            // console.log(`AI GatherState: Skipping defeated enemy: ${info.name}`); // DEBUG
        } else { // Handle missing/invalid relation (defaulting to enemy, but only if not defeated)
            // console.warn(`AI GatherState: Combatant ${info.name || info.id} has missing/invalid relation. Defaulting to enemy.`); // DEBUG
            if (!info.defeated) {
                enemies.push(info);
            }
        }
    });
    // END SAFETY CHECK

    allies.sort((a, b) => a.numericDistance - b.numericDistance);
    enemies.sort((a, b) => a.numericDistance - b.numericDistance);
    let closestEnemyDistance = null; const firstVisibleEnemy = enemies.find(e => !e.defeated && e.numericDistance !== Infinity); if (firstVisibleEnemy) closestEnemyDistance = firstVisibleEnemy.numericDistance;

    // --- Self Info ---
    const permanentNotes = actor.getFlag(MODULE_ID, FLAGS.PERMANENT_NOTES) || ''; // Get permanent notes
    const selfHp = actor.system.attributes?.hp; const selfHpPercent = (selfHp?.max > 0) ? Math.round((selfHp.value / selfHp.max) * 100) : (selfHp?.value > 0 ? 1 : 0); const selfAc = actor.system.attributes.ac?.value; const selfSpeed = actor.system.attributes.speed; const selfSpeedString = selfSpeed?.total ? `${selfSpeed.total}ft` : (selfSpeed?.value ? `${selfSpeed.value}ft` : '?'); const selfFocusPoints = actor.system.resources?.focus; const formatDefense = (items) => items?.map(item => `${item.type} ${item.value}${item.label ? ` (${item.label})` : ''}`).join(', ') || 'None'; const resistances = formatDefense(actor.system.attributes?.resistances); const weaknesses = formatDefense(actor.system.attributes?.weaknesses); const immunities = actor.system.attributes?.immunities?.map(i => i.typeLabel || i.type).join(', ') || 'None';
    let activeStance = { name: "None", desc: null }; try { const stanceEffectItem = actor.itemTypes.effect.find(eff => eff.name.startsWith("Stance:")); if (stanceEffectItem) { activeStance.name = stanceEffectItem.name.replace(/^Stance:\s*/, ''); /* Removed "Stance: " prefix and description */ } } catch (stanceError) { console.warn("AI GatherState: Error processing stance:", stanceError); }
    let sensesString = 'Normal'; try { const sensesData = actor.system.attributes?.senses; if (sensesData && typeof sensesData === 'object') { const sensesList = Object.entries(sensesData).filter(([key, sense]) => sense && typeof sense === 'object' && sense.value > 0 && key !== 'special').map(([key, sense]) => { const label = sense.label || key.charAt(0).toUpperCase() + key.slice(1); const value = sense.value || ''; const unit = sense.unit || (key === 'darkvision' || key === 'low-light-vision' ? '' : ' feet'); const type = sense.type ? ` (${sense.type})` : ''; return `${label}${value ? ' ' + value : ''}${unit}${type}`.trim(); }); if (sensesList.length > 0) sensesString = sensesList.join(', '); } } catch (senseError) { sensesString = 'Error Processing Senses'; }
    let selfFormattedConditions = [];
    let selfFormattedEffects = [];

    try {
        // --- Use Token Document Actor for Conditions/Effects ---
        const tokenActor = selfTokenDocument?.actor;
        if (tokenActor) {
            console.log(`AI Debug Self Cond/Eff (${actor.name} - ${actor.type}): Using Token Actor (${tokenActor.id}) for conditions/effects.`); // DEBUG

            // Process Conditions from Token Actor
            if (tokenActor.itemTypes?.condition?.length > 0) {
                selfFormattedConditions = tokenActor.itemTypes.condition
                    .map(item => formatConditionOrEffect(item, true)) // includeDescription = true
                    .filter(item => item !== null);
            }

            // Process Effects from Token Actor
            if (tokenActor.itemTypes?.effect?.length > 0) {
                selfFormattedEffects = tokenActor.itemTypes.effect
                    .map(item => formatConditionOrEffect(item, true)) // includeDescription = true
                    .filter(item => item !== null);
            }

            // --- Stance Check (using Token Actor's effects) ---
            const stanceEffectItem = tokenActor.itemTypes.effect.find(eff => eff.name.startsWith("Stance:"));
            if (stanceEffectItem) {
                activeStance.name = stanceEffectItem.name.replace(/^Stance:\s*/, '');
                // Optionally format the description if needed later:
                // activeStance.desc = formatConditionOrEffect(stanceEffectItem, true)?.desc;
            } else {
                 activeStance = { name: "None", desc: null }; // Reset if no stance found on token actor
            }
            // --- End Stance Check ---


            // +++ DEBUG LOG: Check results from token actor iteration +++
            console.log(`AI Debug Self Cond/Eff (${actor.name} - ${actor.type}): Conditions found (Token Actor):`, selfFormattedConditions);
            console.log(`AI Debug Self Cond/Eff (${actor.name} - ${actor.type}): Effects found (Token Actor):`, selfFormattedEffects);
            console.log(`AI Debug Self Stance (${actor.name} - ${actor.type}): Stance found (Token Actor):`, activeStance); // DEBUG Stance
            // +++ END DEBUG LOG +++

        } else {
            console.warn(`AI GatherState: Could not find token document actor for ${actor.name}. Conditions/effects might be incomplete.`);
            // Fallback or leave arrays empty if token actor isn't available
            selfFormattedConditions = [];
            selfFormattedEffects = [];
            activeStance = { name: "None", desc: null }; // Reset stance on error
        }

    } catch (selfCondError) {
        console.error(`AI GatherState: Error formatting self conditions/effects for ${actor.name} using token actor:`, selfCondError);
        // Ensure arrays are empty on error
        selfFormattedConditions = [];
        selfFormattedEffects = [];
        activeStance = { name: "None", desc: null }; // Reset stance on error
    }

    // Combine conditions and effects.
    const selfConditionsEffects = [...selfFormattedConditions, ...selfFormattedEffects];
    console.log(`AI Debug Self Cond/Eff (${actor.name} - ${actor.type}): Final selfConditionsEffects Array (from Token Actor):`, selfConditionsEffects); // Log the final combined array



    // --- Strikes ---
    const strikesDataUnsorted = [];
    try {
        // +++ DEBUG LOG: Check the raw actions array +++
        // console.log(`AI Debug: Checking actor.system.actions for ${actor.name}:`, actor.system?.actions); // DEBUG
        // +++ END DEBUG LOG +++

        const allStrikeActions = actor.system.actions?.filter(a => a.type === 'strike') || [];

        // +++ DEBUG LOG: Check the filtered strike actions +++
        // console.log(`AI Debug: Filtered strike actions (allStrikeActions) count: ${allStrikeActions.length}`, allStrikeActions); // DEBUG
        // +++ END DEBUG LOG +++

        // console.log(`AI GatherState: Processing ${allStrikeActions.length} potential strike actions for ${actor.name}.`); // DEBUG

        for (const strikeAction of allStrikeActions) {
            try {
                const strikeName = strikeAction.label || 'Unknown Strike';
                const strikeSlug = strikeAction.slug || strikeName.slugify();

                // +++ DETAILED DEBUG LOG FOR BATTLEFORM STRIKES +++
                if (strikeName === 'Claw' || strikeName === 'Foot' || strikeName === 'Jaws') {
                    console.log(`--- Inspecting Strike Action: ${strikeName} ---`);
                    console.dir(strikeAction); // Log the entire object structure
                }
                // +++ END DETAILED DEBUG LOG +++

                const associatedItemId = strikeAction.itemId || strikeAction.item?.id;
                const associatedItem = associatedItemId ? actor.items.get(associatedItemId) : null;

                // Basic check if action seems valid enough to process further
                if (!associatedItem && !strikeAction.variants?.length && !strikeAction.totalModifier && !strikeAction.item?.system?.damage && !strikeAction.damageFormula) { // Check needed data points
                    // console.warn(`    Skipping strike "${strikeName}" - missing critical data.`);
                    continue;
                }

                // Determine Attack Bonus
                let bonuses = 'N/A'; let baseBonusString = '?'; let calculatedBonuses = [];
                if (Array.isArray(strikeAction.variants) && strikeAction.variants.length > 0 && typeof strikeAction.variants[0].roll === 'function') {
                    const directVariantBonuses = strikeAction.variants.map(v => v.bonus).filter(b => b !== undefined && b !== null);
                    if (directVariantBonuses.length === strikeAction.variants.length && !isNaN(parseInt(directVariantBonuses[0]))) {
                        calculatedBonuses = directVariantBonuses;
                    } else if (strikeAction.totalModifier !== undefined && strikeAction.totalModifier !== null) {
                        const baseBonus = strikeAction.totalModifier;
                        const itemTraits = associatedItem?.system?.traits?.value || strikeAction.item?.system?.traits?.value || strikeAction.traits || []; // Include strikeAction.item traits here
                        const actionTraitsStrings = (strikeAction.traits || []).map(t => t?.name).filter(n => n); // Get names from action traits
                        const combinedTraitStrings = [...new Set([...itemTraits, ...actionTraitsStrings])];
                        const isAgile = combinedTraitStrings.includes('agile');
                        const map2 = baseBonus + (isAgile ? -4 : -5);
                        const map3 = baseBonus + (isAgile ? -8 : -10);
                        calculatedBonuses = [baseBonus, map2, map3];
                    }
                }
                else if (associatedItem?.system?.bonus?.value !== undefined && associatedItem?.system?.bonus?.value !== null) {
                    const bonusValue = associatedItem.system.bonus.value;
                    calculatedBonuses = [bonusValue];
                }
                // Fallback for synthetic actions like BattleForm that might ONLY have totalModifier
                else if (!associatedItem && strikeAction.totalModifier !== undefined && strikeAction.totalModifier !== null) {
                    const baseBonus = strikeAction.totalModifier;
                    const actionTraits = (strikeAction.traits || []).map(t => t?.name).filter(n => n); // Get trait names from the action itself
                    const syntheticItemTraits = strikeAction.item?.system?.traits?.value || []; // Get traits from nested item
                    const combinedTraitStrings = [...new Set([...actionTraits, ...syntheticItemTraits])];
                    const isAgile = combinedTraitStrings.includes('agile');
                    const map2 = baseBonus + (isAgile ? -4 : -5);
                    const map3 = baseBonus + (isAgile ? -8 : -10);
                    calculatedBonuses = [baseBonus, map2, map3];
                    // console.log(`      Used totalModifier fallback for bonus on synthetic strike "${strikeName}"`);
                }
                else { bonuses = 'N/A'; }

                if (calculatedBonuses.length > 0) {
                    bonuses = calculatedBonuses.map(b => `${b >= 0 ? '+' : ''}${b}`).join(' / ');
                    baseBonusString = `${calculatedBonuses[0] >= 0 ? '+' : ''}${calculatedBonuses[0]}`;
                } else {
                    bonuses = 'N/A'; // Ensure bonuses is explicitly N/A if calculation failed
                }

                if (bonuses === 'N/A') {
                    console.warn(`    Skipping strike "${strikeName}" - could not determine attack bonus.`);
                    continue;
                }


                // --- Determine Damage Formula (REVISED LOGIC) ---
                // Initialize damage variables ONCE per strike action
                let damageFormula = "N/A";
                let damageSource = "Unknown";
                let finalNumberOfDice = 1; // Keep Initialization
                let baseDieType = ""; // Keep Initialization
                let damageType = ""; // Keep Initialization
                let staticDamageModifier = 0; // Keep Initialization
                let damageFromStrikeAction = false; // *** Initialize as false ***
                let modifierReason = ""; // Also initialize modifierReason here

                // --- Check strikeAction.item.system.damage type and content (Priority 1) ---
                let damageFound = false; // Flag to track if we successfully found damage by any means
                let isSyntheticSource = false; // Flag specifically for synthetic sources

                // *** Check the BattleForm flag on the nested item ***
                if (strikeAction.item?.flags?.pf2e?.battleForm) {
                    isSyntheticSource = true;
                }

                if (strikeAction.item?.system?.damage) { // Check the NESTED path
                    const dmg = strikeAction.item.system.damage;
                    // Check if it's the expected object structure with valid data
                    if (typeof dmg === 'object' && dmg !== null &&
                        typeof dmg.dice === 'number' && dmg.dice > 0 &&
                        typeof dmg.die === 'string' && dmg.die.startsWith('d') &&
                        typeof dmg.damageType === 'string' && dmg.damageType.length > 0) {
                        finalNumberOfDice = dmg.dice; // Populate from nested object
                        baseDieType = dmg.die; // Populate from nested object
                        damageType = dmg.damageType; // Populate from nested object
                        staticDamageModifier = dmg.modifier ?? 0; // Populate from nested object
                        damageFormula = `${finalNumberOfDice}${baseDieType} ${damageType}`;
                        if (staticDamageModifier !== 0) {
                            damageFormula += ` ${staticDamageModifier >= 0 ? '+' : '-'} ${Math.abs(staticDamageModifier)}`;
                        }
                        damageSource = isSyntheticSource ? "Direct strikeAction.item.system.damage (BattleForm)" : "Direct strikeAction.item.system.damage";
                        damageFromStrikeAction = isSyntheticSource; // <<< Set TRUE only if confirmed synthetic
                        damageFound = true; // Mark success
                    } else {
                        // Log if the nested damage object exists but has invalid properties
                        // console.warn(`AI Debug (${strikeName}): strikeAction.item.system.damage exists but failed property check. Data:`, dmg); // DEBUG
                    }
                    // Check if strikeAction.damage itself is a function (another sign of synthetic)
                } else if (typeof strikeAction.damage === 'function') {
                    isSyntheticSource = true; // It's synthetic if damage is a function
                    damageFromStrikeAction = true; // <<< Set TRUE only here if function
                    damageSource = "strikeAction.damage (Function)";
                    // We still need to find the formula, so don't mark damageFound=true yet
                }
                // --- END Priority 1 Check ---

                // --- Check strikeAction.damageFormula (Priority 1.5) ONLY IF damage wasn't found via object ---
                if (!damageFound && strikeAction.damageFormula && typeof strikeAction.damageFormula === 'string' && strikeAction.damageFormula.trim() !== "" && strikeAction.damageFormula.trim().toLowerCase() !== "n/a") {
                    const formulaString = strikeAction.damageFormula.trim();
                    if (formulaString.includes('d')) { // Basic validation
                        damageFormula = formulaString; // Use the string directly
                        damageSource = "strikeAction.damageFormula (String)";
                        // Attempt to parse components for potential later use, but prioritize the full string
                        const fullMatch = formulaString.match(/^(\d+)d(\d+)\s*([+-]\s*\d+)?\s*(\w+)?$/i);
                        if (fullMatch) { // Try to parse components for fallbacks/consistency if needed
                            finalNumberOfDice = parseInt(fullMatch[1], 10); // Still parse for potential use
                            baseDieType = `d${fullMatch[2]}`; // Still parse for potential use
                            staticDamageModifier = parseInt(fullMatch[3]?.replace(/\s/g, ''), 10) || 0; // Still parse for potential use
                            damageType = fullMatch[4] || 'untyped'; // Still parse for potential use
                        }
                        // *** Set damageFromStrikeAction ONLY if we already know it's synthetic ***
                        damageFromStrikeAction = isSyntheticSource;
                        damageFound = true; // Mark success
                    } else {
                        // Log if formula exists but doesn't look like damage
                        // console.warn(`AI Debug (${strikeName}): strikeAction.damageFormula exists ("${formulaString}") but doesn't look like damage.`); // DEBUG
                    }
                }
                // --- END Priority 1.5 Check ---

                // --- Fallbacks ONLY if direct object and formula string checks failed ---
                // *** damageFromStrikeAction remains FALSE if we enter this block ***
                if (!damageFound) {
                    // Check NPC damage rolls (Priority 2)
                    if (associatedItem?.actor?.type === 'npc' && associatedItem?.system?.damageRolls) {
                        const npcDamageRolls = associatedItem.system.damageRolls;
                        if (typeof npcDamageRolls === 'object' && Object.keys(npcDamageRolls).length > 0) {
                            const firstRollKey = Object.keys(npcDamageRolls)[0];
                            const npcDamageData = npcDamageRolls[firstRollKey];
                            if (npcDamageData?.damage && npcDamageData?.damageType) {
                                damageFormula = `${npcDamageData.damage} ${npcDamageData.damageType}`;
                                damageSource = "NPC damageRolls";
                                const diceMatch = npcDamageData.damage.match(/^(\d+)(d\d+)/);
                                if (diceMatch) { baseDieType = diceMatch[2]; finalNumberOfDice = parseInt(diceMatch[1], 10); } else { baseDieType = "d?"; }
                                damageType = npcDamageData.damageType;
                                if (damageFormula !== "N/A") damageFound = true; // Mark success
                            }
                        }
                    }
                    // Check Rule Element on associatedItem (Priority 3)
                    if (!damageFound && associatedItem?.system?.rules) {
                        const strikeRule = associatedItem.system.rules.find(r => r.key === "Strike" && (!r.slug || r.slug === strikeSlug || associatedItem.slug === strikeSlug));
                        if (strikeRule?.damage?.base) {
                            baseDieType = strikeRule.damage.base.die ?? 'd4';
                            damageType = strikeRule.damage.base.damageType ?? 'bludgeoning';
                            finalNumberOfDice = strikeRule.damage.base.dice ?? 1;
                            damageSource = `RuleElement (${associatedItem.name})`;
                            if (isABPActive && (strikeRule.damage.base.dice ?? 1) === 1) { const level = actor.level; if (level >= 19) finalNumberOfDice = 4; else if (level >= 12) finalNumberOfDice = 3; else if (level >= 4) finalNumberOfDice = 2; else finalNumberOfDice = 1; damageSource += " + ABP Dice"; }
                            else if (!isABPActive && associatedItem?.type === 'weapon') { const strikingRuneLevel = associatedItem?.system?.runes?.striking ?? 0; finalNumberOfDice += strikingRuneLevel; damageSource += ` (Rune Dice: ${strikingRuneLevel})`; }
                            damageFormula = `${finalNumberOfDice}${baseDieType} ${damageType}`;
                            if (damageFormula !== "N/A") damageFound = true; // Mark success
                        }
                    }
                    // Default unarmed (Priority 4)
                    if (!damageFound && strikeSlug === 'basic-unarmed') {
                        baseDieType = 'd4'; damageType = 'bludgeoning'; finalNumberOfDice = 1; damageSource = "Default Unarmed";
                        if (isABPActive) { const level = actor.level; if (level >= 19) finalNumberOfDice = 4; else if (level >= 12) finalNumberOfDice = 3; else if (level >= 4) finalNumberOfDice = 2; damageSource += " + ABP Dice"; }
                        damageFormula = `${finalNumberOfDice}${baseDieType} ${damageType}`;
                        if (damageFormula !== "N/A") damageFound = true; // Mark success
                    }
                    // Fallback Reconstruction from Weapon Item (Priority 5)
                    if (!damageFound && associatedItem?.type === 'weapon') {
                        const weaponDamageParts = associatedItem.system?.damage;
                        if (weaponDamageParts?.die && weaponDamageParts?.damageType) {
                            damageSource = "Fallback Reconstruction - from weaponDamageParts";
                            baseDieType = weaponDamageParts.die; damageType = weaponDamageParts.damageType; finalNumberOfDice = weaponDamageParts.dice ?? 1;
                            if (isABPActive) { const level = actor.level; if (level >= 19) finalNumberOfDice = 4; else if (level >= 12) finalNumberOfDice = 3; else if (level >= 4) finalNumberOfDice = 2; else finalNumberOfDice = 1; damageSource += " (ABP Dice)"; }
                            else { const strikingRuneLevel = associatedItem?.system?.runes?.striking ?? 0; finalNumberOfDice += strikingRuneLevel; damageSource += ` (Rune Dice: ${strikingRuneLevel})`; }
                            damageFormula = `${finalNumberOfDice}${baseDieType} ${damageType}`;
                            if (damageFormula !== "N/A") damageFound = true; // Mark success
                        }
                    }
                    // Fallback Reconstruction from Integrated Trait (Priority 6)
                    if (!damageFound && associatedItem) {
                        const itemTraits = associatedItem.system?.traits?.value || [];
                        const integratedTrait = itemTraits.find(t => typeof t === 'string' && t.startsWith('integrated-'));
                        if (integratedTrait) {
                            const parts = integratedTrait.split('-');
                            if (parts.length >= 3) {
                                const dieMatch = parts[1]?.match(/(\d+)(d\d+)/);
                                if (dieMatch) {
                                    finalNumberOfDice = parseInt(dieMatch[1], 10) || 1;
                                    baseDieType = dieMatch[2];
                                    const typeChar = parts[2]?.toLowerCase();
                                    const typeMap = { s: 'slashing', p: 'piercing', b: 'bludgeoning' };
                                    damageType = typeMap[typeChar] || 'bludgeoning';
                                    damageSource = `Fallback Reconstruction - from Integrated Trait (${integratedTrait})`;
                                    if (isABPActive) { const level = actor.level; if (level >= 19) finalNumberOfDice = 4; else if (level >= 12) finalNumberOfDice = 3; else if (level >= 4) finalNumberOfDice = 2; else finalNumberOfDice = 1; damageSource += " (ABP Dice)"; }
                                    else { const strikingRuneLevel = associatedItem?.system?.runes?.striking ?? associatedItem?.system?.traits?.integrated?.runes?.striking ?? 0; finalNumberOfDice += strikingRuneLevel; damageSource += ` (Rune Dice: ${strikingRuneLevel})`; }
                                    damageFormula = `${finalNumberOfDice}${baseDieType} ${damageType}`;
                                    if (damageFormula !== "N/A") damageFound = true; // Mark success
                                }
                            }
                        }
                    }
                } // End fallbacks block


                if (damageFormula === "N/A") {
                    // This log should now only appear if the direct check AND all fallbacks failed
                    console.warn(`      Could not determine base damage for item "${strikeName}" using any method.`);
                    continue; // Skip this strike if no damage formula found
                }

                // --- Calculate and Apply Static Modifier (STR/DEX/SPEC) ---
                let calculatedAbilityAndSpecMod = 0;
                // AFTER
                // Find Proficiency Rank
                let profRankForSpec = 0; let profSource = "Unknown";
                { // Block scope for proficiency calculation
                    // --- Get Group/Category/Base Robustly ---
                    let weaponGroup = associatedItem?.system?.group ?? strikeAction.item?.system?.group;
                    let weaponCategory = associatedItem?.system?.category ?? strikeAction.item?.system?.category;
                    let baseItemSlugForProf = associatedItem?.system?.baseItem ?? strikeAction.item?.system?.baseItem;
                    // --- End Robust Get ---

                    const baseProfs = actor.system.proficiencies?.attacks;
                    let syntheticProfRank = -1;

                    // Check synthetic ranks first (e.g., from battle form stats)
                    if (strikeSlug) { try { const statistic = actor.getStatistic(strikeSlug); if (statistic && typeof statistic.rank === 'number') { syntheticProfRank = statistic.rank; profSource = `Actor Statistic (${strikeSlug})`; } } catch (e) { /* ignore */ } }
                    if (syntheticProfRank < 0 && associatedItem?.slug) { try { const statistic = actor.getStatistic(associatedItem.slug); if (statistic && typeof statistic.rank === 'number') { syntheticProfRank = statistic.rank; profSource = `Actor Statistic (${associatedItem.slug})`; } } catch (e) { /* ignore */ } }

                    if (syntheticProfRank >= 0) {
                        profRankForSpec = syntheticProfRank; // Use synthetic rank if found
                    } else {
                        // If no synthetic rank, calculate based on actor proficiencies
                        profSource = "Calculated Fallback";
                        let highestFoundRank = 0; // Start at 0 (Untrained)
                        let sourceOfHighest = "Untrained";

                        // --- Explicitly Check Base Item, Group, Category Proficiencies ---
                        const checkProf = (key, label) => {
                            if (key && typeof key === 'string' && baseProfs?.[key]?.rank > highestFoundRank) {
                                highestFoundRank = baseProfs[key].rank;
                                sourceOfHighest = `${label} (${key})`;
                            }
                        };

                        checkProf(baseItemSlugForProf, 'Base Item'); // Check proficiency for 'klar' slug
                        checkProf(weaponGroup, 'Group');             // Check proficiency for 'shield' group
                        checkProf(weaponCategory, 'Category');       // Check proficiency for 'martial' category
                        // --- End Explicit Checks ---

                        // Check Unarmed if applicable (using combined traits logic)
                        const itemTraitsProf = associatedItem?.system?.traits?.value || [];
                        const actionTraitObjectsProf = strikeAction.traits || [];
                        const actionTraitStringsProf = actionTraitObjectsProf.map(traitObj => traitObj?.name).filter(name => typeof name === 'string');
                        const syntheticItemTraitsProf = strikeAction.item?.system?.traits?.value || [];
                        const combinedTraits = [...new Set([...itemTraitsProf, ...actionTraitStringsProf, ...syntheticItemTraitsProf])];
                        const actorUnarmedRank = baseProfs?.unarmed?.rank ?? 0;
                        if ((combinedTraits.includes('unarmed') || strikeSlug === 'basic-unarmed') && actorUnarmedRank > highestFoundRank) {
                            highestFoundRank = actorUnarmedRank;
                            sourceOfHighest = "Unarmed";
                        }

                        // --- Check Rule Elements (updates highestFoundRank if a rule grants better proficiency) ---
                        for (const featOrFeatureItem of actor.items) {
                            if (!featOrFeatureItem.system?.rules) continue;
                            for (const rule of featOrFeatureItem.system.rules) {
                                // Check specifically for MartialProficiency rule elements
                                if (rule.key !== "MartialProficiency" || typeof rule.value !== 'number') continue;

                                // Skip if this rule doesn't apply to the current item/strike
                                // Note: This requires the rule's definition to match the item's traits/group/category
                                // This part is complex and depends heavily on how specific rules are defined.
                                // We'll simplify here and assume if a MartialProficiency rule exists, we check its value.
                                // A more robust check would involve parsing rule.definition precisely.

                                // Example simple check: If rule applies to 'all martial weapons' and item is martial
                                let isPotentiallyApplicable = false;
                                if (Array.isArray(rule.definition)) {
                                    if (rule.definition.includes("weapon:category:martial") && weaponCategory === "martial") {
                                        isPotentiallyApplicable = true;
                                    }
                                    if (rule.definition.includes(`weapon:group:${weaponGroup}`) && weaponGroup) {
                                        isPotentiallyApplicable = true;
                                    }
                                    // Add more complex definition checks as needed
                                }

                                if (isPotentiallyApplicable && rule.value > highestFoundRank) {
                                    highestFoundRank = rule.value;
                                    sourceOfHighest = `RE (${featOrFeatureItem.name})`;
                                }
                            }
                        }
                        // --- End Rule Element Check ---

                        profRankForSpec = highestFoundRank;
                        profSource = sourceOfHighest; // Update the source based on the highest rank found
                    }
                } // End block scope for proficiency calculation

                // Calculate Relevant Ability Modifier (STR/DEX)
                const strMod = actor?.abilities?.str?.mod ?? 0;
                const dexMod = actor?.abilities?.dex?.mod ?? 0;
                const actionTraitsForAbility = (strikeAction.traits || []).map(t => t?.name).filter(n => n);
                const syntheticItemTraitsForAbility = strikeAction.item?.system?.traits?.value || [];
                const itemTraitsAbility = [...new Set([...(associatedItem?.system?.traits?.value || []), ...actionTraitsForAbility, ...syntheticItemTraitsForAbility])];
                let relevantAbilityMod = 0;
                modifierReason = ""; // Re-initialize reason for this strike
                if (itemTraitsAbility.includes('ranged') || associatedItem?.isRanged) {
                    relevantAbilityMod = 0; // Ranged attacks don't add STR/DEX by default
                    modifierReason = "Ranged ";
                    if (itemTraitsAbility.includes('propulsive')) {
                        const strBonusForPropulsive = (strMod > 0) ? Math.floor(strMod / 2) : 0;
                        if (strBonusForPropulsive > 0) { relevantAbilityMod += strBonusForPropulsive; modifierReason += `+Prop(${strBonusForPropulsive}) `; }
                        else { modifierReason += "+Prop(0) "; }
                    } else if (itemTraitsAbility.includes('thrown')) {
                        relevantAbilityMod += strMod; // Thrown adds full STR
                        modifierReason += `+ThrownStr(${strMod}) `;
                    }
                } else { // Melee calculation
                    relevantAbilityMod = strMod; // Default to STR
                    modifierReason = `Str(${strMod}) `;
                    if (itemTraitsAbility.includes('finesse') && dexMod > strMod) {
                        relevantAbilityMod = dexMod; // Use DEX if finesse and higher
                        modifierReason = `Finesse(Dex ${dexMod}) `;
                    } else if (itemTraitsAbility.includes('finesse')) {
                        modifierReason = `Finesse (using Str ${strMod}) `; // Note Str is used despite finesse
                    }
                }
                calculatedAbilityAndSpecMod += relevantAbilityMod;


                // Calculate Weapon Specialization Bonus
                const weaponSpecFeat = actor?.items.find(i => i.slug === 'weapon-specialization');
                const greaterWeaponSpecFeat = actor?.items.find(i => i.slug === 'greater-weapon-specialization');
                let specDamage = 0;

                // --- Ensure weaponGroup/Category are defined for the debug log/later use ---
                // Use the same robust logic as inside the proficiency block
                let weaponGroup = associatedItem?.system?.group ?? strikeAction.item?.system?.group;
                let weaponCategory = associatedItem?.system?.category ?? strikeAction.item?.system?.category;

                if (weaponSpecFeat) {
                    // Determine the relevant proficiency rank for spec bonus
                    // We already calculated the highest applicable proficiency in profRankForSpec earlier

                    if (profRankForSpec >= 2) { // Check if the relevant rank is Expert+
                        if (profRankForSpec === 4) specDamage = 4; // Legendary
                        else if (profRankForSpec === 3) specDamage = 3; // Master
                        else specDamage = 2; // Expert

                        if (specDamage > 0) { // Ensure damage is positive before adding
                            if (greaterWeaponSpecFeat) {
                                specDamage *= 2;
                                modifierReason += `GWS(${specDamage}) `;
                            } else {
                                modifierReason += `WS(${specDamage}) `;
                            }
                            calculatedAbilityAndSpecMod += specDamage;
                        }
                    }
                }

                // --- APPLY the calculated mod ONLY if damage didn't come directly from strikeAction object/formula ---
                if (!damageFromStrikeAction && calculatedAbilityAndSpecMod !== 0 && damageSource !== "NPC damageRolls") {
                    const existingModMatch = damageFormula.match(/([+-]\s*\d+)$/);
                    if (!existingModMatch) {
                        damageFormula += ` ${calculatedAbilityAndSpecMod > 0 ? '+' : '-'} ${Math.abs(calculatedAbilityAndSpecMod)}`;
                        
                    } 
                } else if (damageFromStrikeAction) {
                } 


                // Determine Readiness
                let isReady = false;
                // Assume battleform/monk strikes are ready if damage came directly or if it's basic unarmed
                if (!associatedItem) { isReady = (strikeSlug === 'basic-unarmed' || damageFromStrikeAction); }
                else { const itemType = associatedItem.type; const equippedData = associatedItem.system.equipped; if (itemType === 'weapon' || itemType === 'shield') { isReady = (equippedData?.handsHeld ?? 0) > 0; } else if (itemType === 'feat' || itemType === 'ancestryfeature' || itemType === 'melee') { isReady = true; } } /*console.log(`      Determined Ready Status for ${strikeName}: ${isReady}`);*/

                // Determine Range/Reach/Details
                let meleeReachFt = null; // Initialize as null
                let thrownRangeFt = null;
                let rangedRangeFt = null;
                let reloadTime = null;
                let volleyFt = null;
                const allTraits = [...new Set([...(associatedItem?.system?.traits?.value || []), ...(strikeAction.traits || []).map(t => t?.name).filter(n => n), ...(strikeAction.item?.system?.traits?.value || [])])];

                // *** NEW: Override readiness if unarmed trait is present ***
                if (allTraits.includes('unarmed')) {
                    isReady = true;
                }
                // *** END NEW ***

                // --- Define if it's MELEE first ---
                const isActuallyMelee = allTraits.includes('unarmed') || associatedItem?.isMelee || allTraits.includes('melee') || false;

                // --- Calculate MELEE reach ONLY if it IS melee ---
                if (isActuallyMelee) {
                    const reachTraitData = allTraits.find(t => typeof t === 'string' && t.startsWith("reach-"));
                    let parsedReachValue = null;
                    if (reachTraitData) {
                        const reachNum = parseInt(reachTraitData.split('-')[1], 10);
                        if (!isNaN(reachNum) && reachNum > 0) {
                            parsedReachValue = reachNum;
                        } else {
                            // console.warn(`AI Reach Warn (${strikeName}): Found reach trait '${reachTraitData}' but failed to parse valid number.`); // DEBUG
                        }
                    }
                    meleeReachFt = parsedReachValue ?? 5; // Default to 5 ONLY if it's melee and no trait found/parsed
                }
                // --- END Melee Reach Calculation ---

                // --- Calculate RANGED range ---
                const BOW_RANGES = { 'longbow': 100, 'shortbow': 60, 'composite-longbow': 100, 'composite-shortbow': 60, 'rotary-bow': 80, 'gauntlet-bow': 60, 'shield-bow': 50, 'bow-staff': 80, 'mammoth-bow': 180, 'sky-piercing-bow': 60, 'bow-of-sun-slaying': 60 };
                const rangeIncrementTrait = allTraits.find(t => typeof t === 'string' && t.startsWith("range-increment-"));
                if (rangeIncrementTrait) {
                    const rangeNum = parseInt(rangeIncrementTrait.split('-')[2], 10); // Parse "range-increment-X"
                    if (!isNaN(rangeNum)) rangedRangeFt = rangeNum;
                }
                // Check direct range property if increment trait wasn't found/parsed
                if (rangedRangeFt === null && associatedItem?.system?.range?.value && associatedItem.system.range.value !== "-") {
                    const parsedRange = parseInt(associatedItem.system.range.value, 10);
                    if (!isNaN(parsedRange)) rangedRangeFt = parsedRange;
                }
                // Check hardcoded bow ranges as fallback
                const baseItemSlug = associatedItem?.baseItem || associatedItem?.slug;
                if (rangedRangeFt === null && baseItemSlug && BOW_RANGES[baseItemSlug]) {
                    rangedRangeFt = BOW_RANGES[baseItemSlug];
                }
                // --- End Ranged Calculation ---

                // --- Calculate THROWN range ---
                const thrownTraitString = allTraits.find(t => typeof t === 'string' && t.startsWith('thrown')); // Find base "thrown" or "thrown-X"
                if (thrownTraitString) {
                    // ** Ranged weapons with thrown use their range increment **
                    // Check if it's primarily a ranged weapon OR if it lacks the melee trait
                    const isRangedWeapon = associatedItem?.isRanged || !allTraits.includes('melee');
                    // Read range, checking both .value and direct property
                    const itemRangeValue = associatedItem?.system?.range?.value ?? associatedItem?.system?.range;

                    // +++ Javelin Debugging +++
                    if (strikeName.toLowerCase().includes('javelin')) {
                        // console.log(`AI Debug Javelin Range Check: thrownTraitString='${thrownTraitString}', isRangedWeapon=${isRangedWeapon}, itemRangeValue=${itemRangeValue} (${typeof itemRangeValue})`); // DEBUG
                    }
                    // +++ End Javelin Debugging +++

                    // Use item's direct range if it's considered ranged *and* has a valid range property
                    if (isRangedWeapon && itemRangeValue && itemRangeValue !== "-") {
                        const parsedRange = parseInt(itemRangeValue, 10);
                        if (!isNaN(parsedRange)) {
                            thrownRangeFt = parsedRange;
                            // if (strikeName.toLowerCase().includes('javelin')) { console.log(`   >> Set thrownRangeFt=${thrownRangeFt} from item's range.`); }
                        } else {
                            // if (strikeName.toLowerCase().includes('javelin')) { console.warn(`   >> Failed to parse item range value: ${itemRangeValue}`); }
                        }
                    }

                    // Fallback: If still null, parse the trait (e.g., thrown-20) or default to 10
                    if (thrownRangeFt === null) {
                        const match = thrownTraitString.match(/^thrown-(\d+)$/);
                        thrownRangeFt = match?.[1] ? parseInt(match[1], 10) : 10; // Default 10
                        // if (strikeName.toLowerCase().includes('javelin')) { console.log(`   >> Set thrownRangeFt=${thrownRangeFt} from trait parse/default.`); }
                    }
                }
                // --- End Thrown Calculation ---

                // --- Volley / Reload ---
                const volleyTrait = allTraits.find(t => typeof t === 'string' && t.startsWith("volley-")); // Ensure string check
                if (volleyTrait) { const match = volleyTrait.match(/^volley-(\d+)$/); if (match?.[1]) volleyFt = parseInt(match[1], 10); if (associatedItem?.slug === 'mammoth-bow') volleyFt = 50; }
                const itemReloadProp = associatedItem?.system?.reload?.value;
                if (itemReloadProp && itemReloadProp !== "-" && itemReloadProp !== "0" && itemReloadProp !== 0) { reloadTime = itemReloadProp; }


                // --- Build detail string (Revised) ---
                let detailParts = [];
                // 1. Add Reach ONLY if meleeReachFt has a value (meaning it IS melee)
                if (meleeReachFt !== null) {
                    detailParts.push(`Reach ${meleeReachFt}ft`);
                }
                // 2. Add Thrown ONLY if thrownRangeFt has a value
                if (thrownRangeFt !== null) {
                    detailParts.push(`Thrown ${thrownRangeFt}ft`);
                }
                // 3. Add Range ONLY if rangedRangeFt has a value AND it's different from thrownRangeFt (or thrown is null)
                //    This prevents "Thrown 20ft | Range 20ft" for things like daggers.
                if (rangedRangeFt !== null && (thrownRangeFt === null || rangedRangeFt !== thrownRangeFt)) {
                    detailParts.push(`Range ${rangedRangeFt}ft`);
                }
                // 4. Add Reload/Volley
                if (reloadTime) detailParts.push(`Reload ${reloadTime}`);
                if (volleyFt !== null) detailParts.push(`Volley ${volleyFt}ft`);

                const finalDetailString = detailParts.join(' | ');
 
                // Calculate numeric range for sorting
                const numericRange = Math.max(meleeReachFt || 0, thrownRangeFt || 0, rangedRangeFt || 0);
                const rangeForMarker = (meleeReachFt !== null && numericRange <= 5) ? 5 : numericRange;
 
                // *** Check for Stance/Flourish Traits (for Strikes) ***
                if (allTraits.includes('stance')) hasStanceAction = true;
                if (allTraits.includes('flourish')) hasFlourishAction = true;
                // *** END Trait Check ***
 
                // Filter traits for display - Refined logic
                const traitsToRemoveFromDisplay = ['attack', 'melee', 'ranged']; // Base types often implied or redundant
                const prefixesToRemove = ['range-increment', 'integrated', 'reload']; // Prefixes for mechanics handled elsewhere or internal
                const prefixesToKeepBaseOnly = ['thrown', 'volley', 'reach']; // Keep base word if no number, remove if number exists (e.g. keep 'thrown', remove 'thrown-20')
 
                const displayTraits = allTraits.filter(t => {
                    if (!t || typeof t !== 'string') return false; // Basic validation
                    if (traitsToRemoveFromDisplay.includes(t)) return false; // Remove base types

                    // Remove prefixed traits *with numbers* (e.g., reach-15, thrown-20, volley-30)
                    if (prefixesToKeepBaseOnly.some(prefix => t.startsWith(prefix + '-') && /\d/.test(t))) return false;
                    // Remove other specific prefixed traits entirely
                    if (prefixesToRemove.some(prefix => t.startsWith(prefix + '-'))) return false;

                    // Allow versatile-X traits (but maybe remove base 'versatile' if specific exists? Optional)
                    // if (t === 'versatile' && allTraits.some(other => other.startsWith('versatile-'))) return false;

                    return true; // Keep the trait
                }).join(', ');

                // Extract Attack Effects
                let attackEffectString = '';
                const attackEffects = associatedItem?.system?.attackEffects?.value || strikeAction.item?.system?.attackEffects?.value || []; // Check nested item too
                if (Array.isArray(attackEffects) && attackEffects.length > 0) { const effectNameMap = { 'improved-grab': 'Improved Grab', 'improved-knockdown': 'Improved Knockdown', 'improved-push': 'Improved Push', 'grab': 'Grab', 'knockdown': 'Knockdown', 'push': 'Push' }; const effectNames = attackEffects.map(slug => effectNameMap[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())); attackEffectString = `(plus ${effectNames.join(', ')})`; }


                // --- Push final data ---
                if (damageFormula && damageFormula !== "N/A") {
                    strikesDataUnsorted.push({
                        name: strikeName,
                        identifier: strikeSlug,
                        imageUrl: associatedItem?.img || strikeAction.item?.img || strikeAction.imageUrl || 'icons/svg/mystery-man.svg', // Include nested item image
                        bonuses: bonuses,
                        damage: damageFormula.trim(), // Use the potentially modified formula
                        traits: displayTraits,
                        agile: allTraits.includes('agile'),
                        details: finalDetailString,
                        itemUuid: associatedItem?.uuid || strikeAction.item?.uuid || null, // Include nested item UUID
                        itemId: associatedItem?.id || strikeAction.item?._id || null, // Include nested item ID
                        ready: isReady,
                        weapon: associatedItem || strikeAction.item || null, // Include nested item reference
                        numericRange: rangeForMarker,
                        attackEffectString: attackEffectString,
                        _internalHasGrab: attackEffectString.toLowerCase().includes('grab') // Internal flag for grab check
                    });
                } else {
                    // console.warn(`    Skipping push for strike "${strikeName}" due to invalid final damage formula.`);
                }


            } catch (singleStrikeError) { console.error(`AI GatherState: Error processing individual strike "${strikeAction?.label || 'Unknown'}":`, singleStrikeError); }
        } // End of strike loop
    } catch (strikeProcessingError) { console.error(`AI GatherState: Error during overall strike processing:`, strikeProcessingError); }
    const strikesData = strikesDataUnsorted.sort((a, b) => b.numericRange - a.numericRange || a.name.localeCompare(b.name));
    // Check if any strike has grab after processing all strikes
    if (strikesData.some(s => s._internalHasGrab)) {
        hasGrabAttack = true;
    }
    // console.log(`...Processed ${strikesData.length} strikes.`);

    // --- Consumables ---
    const affordableConsumables = [];
    try {
        const affordabilityCheckConsumable = (item) => { const cost = parseActionCostValue(null, null, item.system.description?.value, item.system.actionType?.value); const defaultCost = (item.system.consumableType?.value === 'scroll' || item.system.consumableType?.value === 'wand') ? null : 1; const finalCostValue = cost ?? defaultCost ?? 1; let minCost = 99; if (finalCostValue === 'R' || finalCostValue === 'F' || finalCostValue === 0) minCost = 0; else if (typeof finalCostValue === 'string' && finalCostValue.includes(' to ')) minCost = parseInt(finalCostValue.split(' to ')[0], 10); else if (Number.isInteger(finalCostValue)) minCost = finalCostValue; if (isNaN(minCost)) minCost = 99; return minCost <= actionsRemaining; };
        actor.itemTypes.consumable.filter(c => c.system.quantity > 0).forEach(consumable => {
            if (affordabilityCheckConsumable(consumable)) {
                const parsedCost = parseActionCostValue(null, null, consumable.system.description?.value, consumable.system.actionType?.value);
                const defaultCost = (consumable.system.consumableType?.value === 'scroll' || consumable.system.consumableType?.value === 'wand') ? null : 1;
                const finalCostValue = parsedCost ?? defaultCost;
                const fullDesc = summarizeAbilityDetails(consumable.system.description?.value);
                const excludeDesc = shouldExcludeDescription(fullDesc, consumable.name);
                affordableConsumables.push({ id: consumable.id, name: consumable.name, uuid: consumable.uuid, costText: formatParsedCostToDisplay(finalCostValue), costValue: finalCostValue, quantity: consumable.system.quantity, traits: consumable.system.traits?.value?.join(', ') || '', fullDesc: excludeDesc ? '' : fullDesc, numericRange: getNumericRange(consumable, 'gatherGameState-consumable') });
                // *** Check for Free Action Cost ***
                if (finalCostValue === 'F' || finalCostValue === 0) {
                    hasFreeActions = true;
                }
                // *** END Free Action Check ***
            }
        });
        affordableConsumables.sort(sortSpellsForPrompt); // Sort consumables like spells
    } catch (consumableError) { console.error(`AI GatherState: Error processing consumables:`, consumableError); }


    // --- Assemble Final State Object ---
    const selfInfo = {
        id: currentCombatant.id, name: currentCombatant.name || 'Unknown Self', coordinates: selfCoordinates,
        hp: selfHp ? { value: selfHp.value, max: selfHp.max } : { value: '?', max: '?' }, hpPercent: selfHpPercent,
        ac: selfAc ?? '?', speed: selfSpeedString,
        focusPoints: selfFocusPoints ? { value: selfFocusPoints.value ?? 0, max: selfFocusPoints.max ?? 0 } : { value: 0, max: 0 },
        conditionsEffects: selfConditionsEffects,
        activeStance: activeStance,
        size: actor.size || 'unknown', senses: sensesString,
        strikes: strikesData,
        _actionsAndActionFeatsList: activatableActionsAndFeats, _comboSetupActionsList: comboSetupActions, passiveAbilities: passiveAbilities,
        spells: collectedSpells.leveled, // Use the collected lists
        focusSpells: collectedSpells.focus,
        cantrips: collectedSpells.cantrips,
        itemGrantedSpells: collectedSpells.item,
        permanentNotes: permanentNotes, // Add permanent notes here
        resistances: resistances, weaknesses: weaknesses, immunities: immunities, consumables: affordableConsumables
    };

    const sceneInfo = { name: scene?.name ?? 'Unknown Scene', gridSize: grid?.size ?? 100, gridDistance: grid?.distance ?? 5, gridUnits: grid?.units ?? 'ft' };

    // --- Gather Recent Events (Chat Messages) ---
    let recentEvents = [];
    try {
        // --- Get Turn Start Time from Flag (Set by Hook) ---
        const turnStartTime = combat?.getFlag(MODULE_ID, 'turnStartTime');

        console.log(`AI Debug Events: Turn Start Time from Flag: ${turnStartTime ? new Date(turnStartTime).toISOString() : 'Not Found/Set'}`); // DEBUG
        if (turnStartTime) {
            const allMessages = game.messages;
            console.log(`AI Debug Events: Total messages checked: ${allMessages.size}`); // DEBUG
            const messagesAfterTime = allMessages.filter(msg => msg.timestamp >= turnStartTime);
            console.log(`AI Debug Events: Messages after turn start time: ${messagesAfterTime.length}`); // DEBUG

            const filteredMessages = messagesAfterTime.filter(msg => {
                // Removed isNotOwn check to include AI's own action results
                const isNotOffer = !msg.getFlag(MODULE_ID, FLAGS.OFFER_ID);
                const isNotThinking = !msg.getFlag(MODULE_ID, FLAGS.TEMP_THINKING);
                const isRelevantContent = (msg.isRoll || msg.content.includes('damage') || msg.content.includes('cast') || msg.content.includes('save') || msg.content.includes('check') || msg.content.includes('Strike') || msg.content.includes('attack'));
                // DEBUG Log individual filter results (Adjusted for removed isNotOwn)
                if (!isNotOffer) console.log(`AI Debug Events Filtered Out (Offer Flag): ID=${msg.id}`);
                else if (!isNotThinking) console.log(`AI Debug Events Filtered Out (Thinking Flag): ID=${msg.id}`);
                else if (!isRelevantContent) console.log(`AI Debug Events Filtered Out (Irrelevant Content): ID=${msg.id}, isRoll=${msg.isRoll}, Content='${msg.content?.substring(0, 100)}...'`);
                // ---
                return isNotOffer && isNotThinking && isRelevantContent; // Removed isNotOwn check
            });
            console.log(`AI Debug Events: Messages after all filters: ${filteredMessages.length}`); // DEBUG

            // --- Consolidate Attack Events ---
            recentEvents = await filteredMessages.reduce(async (accPromise, msg) => {
                const acc = await accPromise; // Resolve the accumulator promise
                console.log("PF2e AI Combat Assistant | Processing message object for recentEvents:", msg); // DEBUG: Log the full message object being processed
                const speakerName = msg.speaker?.alias || msg.user?.name || 'Unknown';
                const context = msg.flags?.pf2e?.context;
// --- PRIORITIZE REGENERATION CHECK BASED ON FLAVOR TEXT ---
let isRegenRoll = false;
let regenAmount = 0;
let processedAsRegen = false;

// Check flavor text first, then confirm it's a roll with data
if (msg.flavor?.toLowerCase().includes('regeneration') && msg.isRoll && msg.rolls?.length > 0) {
    console.log(`AI Debug Events: Found 'regeneration' in flavor text for msg ID ${msg.id}.`); // DEBUG + ID
    isRegenRoll = true; // Assume it's regen for now

    // Now try to get the amount
    try {
        let rollData = null;
        if (typeof msg.rolls[0] === 'string') {
            rollData = JSON.parse(msg.rolls[0]);
        } else if (typeof msg.rolls[0] === 'object' && msg.rolls[0] !== null) {
            rollData = msg.rolls[0];
        }

        if (rollData) {
            regenAmount = rollData.total ?? 0;
            console.log(`AI Debug Events: Parsed total regeneration amount: ${regenAmount} for msg ID ${msg.id}.`); // DEBUG + ID
        } else {
             console.log(`AI Debug Events: rollData was null/undefined when trying to get regen amount for msg ID ${msg.id}.`); // DEBUG + ID
             isRegenRoll = false; // Can't confirm amount, treat as non-regen
        }
    } catch (e) {
        console.warn(`AI Debug Events: Error parsing roll JSON/object to get regen amount for msg ID ${msg.id}:`, e, msg.rolls[0]);
        isRegenRoll = false; // Reset if parsing fails
    }

    // Push the event if we successfully identified it and got an amount
    if (isRegenRoll && regenAmount > 0) {
        console.log(`AI Debug Events: Pushing formatted regeneration event for msg ID ${msg.id}.`); // DEBUG + ID
        acc.push(`${speakerName} received ${regenAmount} Regeneration`);
        processedAsRegen = true; // Mark as processed
        console.log(`AI Debug Events: Returning accumulator early after processing regeneration for msg ID ${msg.id}.`); // DEBUG + ID
        // IMPORTANT: Return early to prevent further processing
        return acc;
    } else {
         console.log(`AI Debug Events: Conditions for regeneration event not met for msg ID ${msg.id} (isRegenRoll=${isRegenRoll}, regenAmount=${regenAmount}).`); // DEBUG + ID
    }
}
// --- END REGENERATION CHECK ---

// --- STANDARD CONTEXT PROCESSING (if not handled as regeneration) ---
if (!processedAsRegen) {
    if (context?.type === 'attack-roll') {
        try {
            const outcome = context.outcome ? context.outcome.charAt(0).toUpperCase() + context.outcome.slice(1) : 'Unknown Outcome'; // Capitalize

            // --- Get Item Name ---
            let itemName = 'Attack'; // Default
            if (context.title) {
                const titleParts = context.title.split(':');
                itemName = titleParts.length > 1 ? titleParts[1].trim() : context.title.trim();
            } else {
                const itemOption = context.options?.find(o => /^item:[a-zA-Z0-9_-]+$/.test(o) && !o.includes(':category:') && !o.includes(':trait:') && !o.includes(':group:'));
                if (itemOption) { itemName = itemOption.split(':')[1].charAt(0).toUpperCase() + itemOption.split(':')[1].slice(1); }
                else { let itemUuid = context.item?.uuid || context.origin?.uuid; if (itemUuid) { try { const item = await fromUuid(itemUuid); if (item?.name) { itemName = item.name; } } catch (uuidError) { console.warn(`AI Debug Events: Error fetching item from UUID ${itemUuid} during fallback:`, uuidError); } } }
            }

            // --- Extract Rider Effects ---
            let riderString = "";
            if (Array.isArray(context.notes)) {
                const knownRiders = ["grab", "push", "knockdown", "trip"];
                for (const note of context.notes) { if (note.title && knownRiders.includes(note.title.toLowerCase())) { riderString += ` (plus ${note.title})`; } }
            }

            // --- Get Target Name ---
            let targetName = 'Unknown Target';
            const targetContext = msg.flags?.pf2e?.context?.target;
            if (targetContext?.token) { try { const targetToken = fromUuidSync(targetContext.token); if (targetToken?.name) { targetName = targetToken.name; } } catch (err) { console.warn(`AI Debug Events: Failed to resolve target token UUID ${targetContext.token}:`, err); } }
            if (targetName === 'Unknown Target' && targetContext?.actor) { try { const targetActor = fromUuidSync(targetContext.actor); if (targetActor?.name) { targetName = targetActor.name; } } catch (err) { console.warn(`AI Debug Events: Failed to resolve target actor UUID ${targetContext.actor}:`, err); } }
            if (targetName === 'Unknown Target' && msg.flavor) { const flavorMatch = msg.flavor.match(/Target:\s*([^<(]+)/i); if (flavorMatch?.[1]) { targetName = flavorMatch[1].trim(); } }

            const eventString = `${speakerName}: ${itemName} Strike on ${targetName} -> ${outcome}${riderString}`;
            acc.push(eventString);

        } catch (error) {
            console.error("PF2e AI Combat Assistant | Error processing attack roll message:", error, msg);
            acc.push(`${speakerName}: Attack Roll (Error processing details)`);
        }
    } else if (context?.type === 'damage-roll') {
        console.log(`AI Debug Events: Skipping damage roll message ID=${msg.id} for consolidation.`);
    } else if (context?.type === 'skill-check') {
         try {
            const outcome = context.outcome ? context.outcome.charAt(0).toUpperCase() + context.outcome.slice(1) : 'Unknown Outcome';
            let skillName = context.stat?.charAt(0).toUpperCase() + context.stat?.slice(1) || 'Skill Check';
            if (context.options?.includes('action:grapple')) skillName = "Grapple";
            const eventString = `${speakerName}: ${skillName} Check -> ${outcome}`;
            acc.push(eventString);
        } catch (error) {
             console.error("PF2e AI Combat Assistant | Error processing skill check message:", error, msg);
             acc.push(`${speakerName}: Skill Check (Error processing details)`);
        }
    } else if (context?.type === 'saving-throw') {
        try {
           const outcome = context.outcome ? context.outcome.charAt(0).toUpperCase() + context.outcome.slice(1) : 'Unknown Outcome';
           let saveType = 'Save'; let effectName = 'Unknown Effect'; let dcValue = null;
           if (context.dc?.value) { dcValue = context.dc.value; if (context.dc.label) { const dcLabel = context.dc.label.trim(); const dcSuffix = " DC"; if (dcLabel.endsWith(dcSuffix)) { effectName = dcLabel.substring(0, dcLabel.length - dcSuffix.length).trim(); } } }
           if (context.stat) { saveType = context.stat.charAt(0).toUpperCase() + context.stat.slice(1); }
           else if (context.title) { const title = context.title.trim(); const saveTypes = ["Will", "Fortitude", "Reflex"]; for (const type of saveTypes) { if (title.toLowerCase().startsWith(type.toLowerCase())) { saveType = type; break; } } }
           if (effectName === 'Unknown Effect') { if (context.item?.name) { effectName = context.item.name; } else if (context.options) { const itemOption = context.options.find(o => o.startsWith('item:') && !o.includes(':trait:') && !o.includes(':cost:') && !o.includes(':type:') && !o.includes(':id:') && !o.includes(':action:')); if (itemOption) { effectName = itemOption.split(':')[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()); } } else if (context.title && context.title.trim().toLowerCase() !== saveType.toLowerCase() && !context.title.toLowerCase().includes('saving throw')) { effectName = context.title.trim(); } }
           let eventString = `${speakerName}: ${saveType} Save vs ${effectName}`;
           if (dcValue !== null) { eventString += ` (DC: ${dcValue})`; }
           eventString += ` -> ${outcome}`;
           acc.push(eventString);
        } catch (error) {
            console.error("PF2e AI Combat Assistant | Error processing saving throw message:", error, msg);
            acc.push(`${speakerName}: Saving Throw (Error processing details)`);
        }
    // --- ADDED: Handle Spell Cast ---
    } else if (context?.type === 'spell-cast') {
        try {
            let spellName = 'Unknown Spell';
            let spellRank = '';
            if (msg.content) {
                // Extract name from <h3> tag, removing the action glyph span if present
                const nameMatch = msg.content.match(/<h3[^>]*>(.*?)<span[^>]*action-glyph[^>]*>.*?<\/span>.*?<\/h3>/i)
                               || msg.content.match(/<h3[^>]*>(.*?)<\/h3>/i); // Fallback if no glyph
                if (nameMatch?.[1]) {
                    spellName = nameMatch[1].trim();
                }
                // Extract rank from <h4> tag
                const rankMatch = msg.content.match(/<h4[^>]*rank[^>]*>(.*?)<\/h4>/i);
                if (rankMatch?.[1]) {
                    spellRank = ` (${rankMatch[1].trim()})`; // Format as " (Spell 7)"
                }
            }
            const eventString = `${speakerName} Cast ${spellName}${spellRank}`;
            acc.push(eventString);
            console.log(`AI Debug Events: Added Spell Cast event: ${eventString}`); // DEBUG
        } catch (error) {
            console.error("PF2e AI Combat Assistant | Error processing spell cast message:", error, msg);
            acc.push(`${speakerName}: Spell Cast (Error processing details)`);
        }
    // --- END ADDED ---
    } else if (context) { // Handles messages WITH context but no specific recognized type (and not regen/spell-cast)
        if (!msg.isRoll && msg.content) {
             let simpleContent = msg.content.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?p>/gi, '\n').replace(/<[^>]*>/g, " ").replace(/ {2,}/g, ' ').replace(/\n\s*\n/g, '\n').replace(/^\s+|\s+$/gm, '').trim();
             const isDamageApplication = /takes\s+\d+\s+damage|\d+\s+damage\s+to|suffers\s+\d+\s+damage/i.test(simpleContent);
             if (isDamageApplication) { console.log(`AI Debug Events: Skipping likely damage application message ID=${msg.id}: ${simpleContent.substring(0,50)}`); }
             else if (simpleContent.length > 0) { let truncatedContent = simpleContent; const lines = truncatedContent.split('\n'); if (lines.length > 3) { truncatedContent = lines.slice(0, 3).join('\n') + "\n..."; } else if (truncatedContent.length > 150) { truncatedContent = truncatedContent.substring(0, 147) + "..."; } acc.push(`${speakerName}: ${truncatedContent}`); }
        } else if (msg.isRoll) {
            // Fallback for rolls with context but not healing/recognized type
            console.log(`AI Debug Events: Message ID ${msg.id} falling into 'Roll (Context, Unknown Type)' block.`); // DEBUG + ID
            acc.push(`${speakerName}: Roll (Context, Unknown Type)`);
        }
 } else if (msg.isRoll) { // Handles messages WITHOUT context but ARE rolls (and not healing)
            console.log(`AI Debug Events: Message ID ${msg.id} falling into final 'Roll (Unknown Type)' block (No Context).`); // DEBUG + ID
            acc.push(`${speakerName}: Roll (Unknown Type)`);
        }
} // End standard processing block
                // Removed erroneous closing brace that was here

                return acc;
            }, Promise.resolve([])); // Initial value is a resolved promise with an empty array

            // Filter out events that might be empty after "Speaker: " (e.g., only whitespace content)
            // Filter out events that are empty or only whitespace
            recentEvents = recentEvents.filter(event => event.trim().length > 0);
            console.log(`AI Debug Events: Final recentEvents array (count: ${recentEvents.length}):`, recentEvents); // DEBUG
        } else {
             console.warn("AI GatherState: Could not get turn start time flag to gather recent events."); // Updated warning
        }
    } catch (eventError) {
        console.error("AI GatherState: Error gathering recent events from chat:", eventError);
    }
    // --- End Gather Recent Events ---


    // console.log(`PF2e AI Combat Assistant | Finished Gathering State for ${currentCombatant.name}`); // DEBUG
    // Final Debug Logs
    // console.log("DEBUG: Final Leveled Spells:", selfInfo.spells.map(s => s.name + " " + s.rankDisplay));
    // console.log("DEBUG: Final Focus Spells:", selfInfo.focusSpells.map(s => s.name + " " + s.rankDisplay));
    // console.log("DEBUG: Final Cantrips:", selfInfo.cantrips.map(s => s.name + " " + s.rankDisplay));
    // console.log("DEBUG: Final Item Spells:", selfInfo.itemGrantedSpells.map(s => s.name + " " + s.rankDisplay));


    // Determine if actor has variable cost actions (moved near end for clarity)
    let hasVariableCostActions = false;
    const checkVariableCost = (item) => typeof item?.costValue === 'string' && item.costValue.includes(' to ');
    if (
        selfInfo.spells?.some(checkVariableCost) ||
        selfInfo.focusSpells?.some(checkVariableCost) ||
        selfInfo.cantrips?.some(checkVariableCost) ||
        selfInfo.itemGrantedSpells?.some(checkVariableCost) ||
        selfInfo._actionsAndActionFeatsList?.some(checkVariableCost) ||
        selfInfo.consumables?.some(checkVariableCost)
    ) {
        hasVariableCostActions = true;
    }

    return {
        currentTurnCombatantId: currentCombatant.id, scene: sceneInfo, allies: allies, enemies: enemies, closestEnemyDistance: closestEnemyDistance, self: selfInfo, recentEvents: recentEvents,
        // Flags for contextual prompts:
        hasStanceAction: hasStanceAction,
        hasFlourishAction: hasFlourishAction,
        hasAllies: hasAllies,
        canSustainSpells: canSustainSpells,
        hasHealSpell: hasHealSpell,
        hasGrabAttack: hasGrabAttack,
        hasVariableCostActions: hasVariableCostActions, // Include this flag
        hasLeveledSpells: hasLeveledSpells, // Include the new flag
        hasFreeActions: hasFreeActions // Include the free action flag
    };
} // End of gatherGameState function


// `craftSingleActionPrompt`: Updated with Heal guidance and decisive variable cost instructions.
function craftSingleActionPrompt(combatant, gameState, turnState, skippedAction = null, manualNotes = null, interimResults = []) { // Added interimResults parameter
    const actor = combatant?.actor;
    if (!actor || !gameState?.self) {
        console.error("PF2e AI Combat Assistant | craftSingleActionPrompt: Missing actor or self gameState!");
        return "Error: Cannot generate prompt.";
    }

    const closestEnemyDist = gameState.closestEnemyDistance;
    const currentMAP = turnState.currentMAP ?? 0;
    const mapDisplayLabels = { 0: "0", 4: "-4 (Agile)", 5: "-5", 8: "-8 (Agile)", 10: "-10" };
    const mapDisplayString = mapDisplayLabels[currentMAP] || `${currentMAP > 0 ? '-' : ''}${currentMAP}`;
    const EMPTY_LIST_PLACEHOLDER = '  None ';
    const LIST_SEPARATOR = '\n\n---\n\n';
    const includeReactions = game.settings.get(MODULE_ID, 'includeReactionsInPrompt'); // Get the setting value
 
    // Helper function to filter reactions based on the setting

    const filterReactionsIfNeeded = (abilities) => {
        // Ensure abilities is an array before filtering
        const safeAbilities = Array.isArray(abilities) ? abilities : [];
        if (!includeReactions) {
            return safeAbilities.filter(ability => ability.costValue !== 'R');
        }
        return safeAbilities;
    };

    // Create Ability List String function - Includes Range Marker & Empty Desc Check
    const createAbilityListString = (abilities, listType, closestEnemyDist, gameState) => { // Added closestEnemyDist & gameState parameters
        // DEBUG: Log the incoming abilities list, especially for combos
        if (listType === 'Combo Setup Actions') {
            // console.log(`AI createAbilityListString (${listType}): Received abilities:`, JSON.stringify(abilities.map(a => a.name))); // DEBUG
        }
        if (!abilities || abilities.length === 0) return EMPTY_LIST_PLACEHOLDER;
        let markerInserted = false; // Flag to ensure marker is inserted only once
        let output = [];

        for (const ability of abilities) {
            // --- Insert Out-of-Range Marker (Ignore Self spells) ---
            if (!markerInserted && closestEnemyDist !== null && ability.numericRange !== 0 && ability.numericRange < closestEnemyDist) {
                const markerText = `\n  --- ${listType.toUpperCase()}S BELOW THIS LINE ARE OUT OF RANGE (${closestEnemyDist}ft) ---\n`;
                output.push(markerText);
                markerInserted = true; // Ensure marker is inserted only once
            }
            // --- End Marker Insertion ---


            let entryString = '';
            // --- Format Spell ---
            if (listType.includes('Spell') || listType.includes('Cantrip')) {
                let costDisplay = ability.costText || '?';
                if (ability.costValue === "1 to 3") { // Check the parsed value directly
                    costDisplay = "(1 to 3 Actions)"; // Make it clear it's variable
                }
                const rankInfo = ability.rankDisplay || `R${ability.rank}`;
                let detailsLine = '';
                if (ability.range) detailsLine += `Range ${ability.range}; `;
                if (ability.targets) detailsLine += `Targets ${ability.targets}; `;
                if (ability.defense) detailsLine += `Defense ${ability.defense}; `;
                if (ability.area) detailsLine += `Area ${ability.area}; `;
                // AFTER (Uses ability.baseLevel from formatted object)
                if (ability.duration) detailsLine += `Duration ${ability.duration}; `;
                detailsLine = detailsLine.trim();
                // Use the stored baseLevel from the formatted ability object
                const baseRankText = (ability.baseLevel && !ability.isCantrip) ? ` (Base Rank ${ability.baseLevel})` : ''; // <-- Use ability.baseLevel
                entryString = `  - ${ability.name}${ability.fromText || ''} ${baseRankText} (${rankInfo})${ability.traitsString ? ` ${ability.traitsString}` : ''}`;
                if (detailsLine) entryString += `\n    Details: ${detailsLine}`;
                if (ability.fullDesc && ability.fullDesc.length > 0) {
                    entryString += `\n    Description: ${ability.fullDesc}`;
                }
            }

            // --- Format Strike ---
            else if (listType === 'Strike') {
                const stanceNameClean = gameState?.self?.activeStance?.name?.replace(/^Stance:\s*/, '').trim(); // Get clean stance name
                const isStanceStrike = stanceNameClean && ability.name === stanceNameClean;
                const stanceMarker = isStanceStrike ? "(Stance Strike) " : "";
                const readyPrefix = ability.ready ? "(Ready) " : "(Requires Draw/Equip) "; let mapPenaltyValue = 0; if (currentMAP === 5 || currentMAP === 4) mapPenaltyValue = ability.agile ? -4 : -5; else if (currentMAP === 10 || currentMAP === 8) mapPenaltyValue = ability.agile ? -8 : -10; const baseBonusString = ability.bonuses?.split('/')[0]?.trim() ?? '?'; const baseBonusMatch = baseBonusString.match(/([+-]\d+)/); let currentBonusString = baseBonusString; if (baseBonusMatch?.[1]) { const baseBonusNumber = parseInt(baseBonusMatch[1], 10); if (!isNaN(baseBonusNumber)) { const currentBonusNumber = baseBonusNumber + mapPenaltyValue; currentBonusString = `${currentBonusNumber >= 0 ? '+' : ''}${currentBonusNumber}`; } }
                entryString = `  - ${readyPrefix}${stanceMarker}${ability.name}: ${currentBonusString} (Base: ${baseBonusString})`; // Added stanceMarker
                if (ability.damage && ability.damage !== 'N/A') entryString += `, Dmg: ${ability.damage}`;
                if (ability.traits) entryString += `, Traits: [${ability.traits}]`;
                if (ability.details) entryString += ` (${ability.details})`;
                if (ability.attackEffectString) {
                    entryString += ` ${ability.attackEffectString}`; // Append like "(plus Improved Grab)"
                }
            }

            // --- Format Action/Feat/Free ---
            else if (listType === 'Action/Feat/Free') {
                let fullDescCleaned = ability.fullDesc || ""; // Use the cleaned description
                let minRangeText = ''; // Initialize minimum range text
                let triggerText = null; // Initialize parsing variables
                let requirementText = null;
                let effectText = null;

                // --- Attempt to identify MINIMUM component strike range for multi-attack actions ---
                // Heuristic remains the same
                const actionCostNum = (typeof ability.costValue === 'number' && ability.costValue > 1) ? ability.costValue : (ability.costText === '(2a)' ? 2 : (ability.costText === '(3a)' ? 3 : 0));
                const mentionsStrike = /strike/i.test(fullDescCleaned);
                const multiAttackKeywords = ['frenzy', 'flurry', 'two', 'three', 'four', 'five', 'multiple'];
                const mightBeMultiAttack = actionCostNum > 1 && (mentionsStrike || multiAttackKeywords.some(kw => fullDescCleaned.toLowerCase().includes(kw)));

                if (mightBeMultiAttack && gameState?.self?.strikes && ability.name.toLowerCase() !== 'trample') { // Exclude Trample from strike-based range calc
                    let minRequiredRange = Infinity; // <-- Initialize minimum to infinity
                    let foundAnyComponentRange = false; // <-- Track if we found any valid range
                    const actionDescLower = fullDescCleaned.toLowerCase();

                    // Find strikes mentioned by name in the description
                    gameState.self.strikes.forEach(strike => {
                        const strikeNameLower = strike.name.toLowerCase();
                        const regex = new RegExp(`\\b${strikeNameLower.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
                        if (regex.test(actionDescLower)) {
                            // Extract numeric reach/range from the strike's details string
                            const details = strike.details || '';
                            const reachMatch = details.match(/Reach\s+(\d+)/);
                            const thrownMatch = details.match(/Thrown\s+(\d+)/);
                            const rangeMatch = details.match(/Range\s+(\d+)/);
                            // Calculate the max range *for this specific strike component*
                            const currentComponentMaxRange = Math.max(
                                reachMatch ? parseInt(reachMatch[1], 10) : 0,
                                thrownMatch ? parseInt(thrownMatch[1], 10) : 0,
                                rangeMatch ? parseInt(rangeMatch[1], 10) : 0,
                                0
                            );

                            // Update the overall minimum required range IF this component has a positive range
                            if (currentComponentMaxRange > 0) {
                                minRequiredRange = Math.min(minRequiredRange, currentComponentMaxRange); // <-- Update minimum
                                foundAnyComponentRange = true;
                            } else if (details.includes("Reach")) { // Handle default Reach 5ft
                                minRequiredRange = Math.min(minRequiredRange, 5); // <-- Update minimum with default 5
                                foundAnyComponentRange = true;
                            }
                        }
                    });

                    // Format the output string if a valid minimum range was found
                    if (foundAnyComponentRange && minRequiredRange !== Infinity && minRequiredRange > 0) {
                        minRangeText = ` (IMPORTANT! - EFFECTIVE RANGE: ${minRequiredRange}ft)`; // <-- New format
                    } else if (foundAnyComponentRange && minRequiredRange <= 0) {
                        // This case handles if only touch/0ft components were found, maybe indicate Reach 5?
                        minRangeText = ` (IMPORTANT! - EFFECTIVE RANGE: 5ft)`; // Default to 5ft if only 0 range found?
                    }
                }
                // --- End component strike range identification ---

                // --- Revised Parsing Logic: Independent keyword search ---
                // Search for Trigger, Requirements, and Effect sections independently.

                const trigMatch = fullDescCleaned.match(/(?:^|\n)\s*Trigger\s+(.*?)(?=\n\s*(?:Requirements?|Effect|$))/im);
                if (trigMatch) triggerText = trigMatch[1].trim();

                const reqMatch = fullDescCleaned.match(/(?:^|\n)\s*Requirements?\s+(.*?)(?=\n\s*(?:Effect|$))/im);
                if (reqMatch) requirementText = reqMatch[1].trim();

                // Look for Effect text specifically. Handle multi-line Effects.
                const effectMatch = fullDescCleaned.match(/(?:^|\n)\s*Effect\s+(.*)/im);
                if (effectMatch) {
                    effectText = effectMatch[1].trim();
                    // Clean up potential contamination if Req/Trig weren't perfectly separated before Effect
                    if (requirementText && effectText.startsWith(requirementText)) {
                        effectText = effectText.substring(requirementText.length).trim();
                    }
                    if (triggerText && effectText.startsWith(triggerText)) {
                        effectText = effectText.substring(triggerText.length).trim();
                    }
                } else if (!triggerText && !requirementText) {
                    // If no keywords found, assume the whole thing is the effect/description
                    effectText = fullDescCleaned;
                }
                // --- End Revised Parsing Logic ---

                // --- Trample Specific Strike Reference ---
                if (ability.name.toLowerCase() === 'trample' && effectText && gameState?.self?.strikes?.length > 0) {
                    let referencedStrikeName = null;
                    const effectTextLower = effectText.toLowerCase();
                    const strikes = gameState.self.strikes;

                    // 1. Check if description mentions a specific strike
                    for (const strike of strikes) {
                        const strikeNameLower = strike.name.toLowerCase();
                        const regex = new RegExp(`\\b${strikeNameLower.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
                        if (regex.test(effectTextLower)) {
                            referencedStrikeName = strike.name;
                            break; // Found the first mentioned strike
                        }
                    }

                    // 2. If no strike mentioned, find the one with the shortest range
                    if (!referencedStrikeName) {
                        let shortestRange = Infinity;
                        let shortestRangeStrikeName = null;

                        for (const strike of strikes) {
                            const details = strike.details || '';
                            const reachMatch = details.match(/Reach\s+(\d+)/);
                            const thrownMatch = details.match(/Thrown\s+(\d+)/);
                            const rangeMatch = details.match(/Range\s+(\d+)/);

                            let currentRange = 0; // Default for non-range/reach strikes (shouldn't happen often)
                            if (reachMatch) currentRange = parseInt(reachMatch[1], 10);
                            if (thrownMatch) currentRange = Math.max(currentRange, parseInt(thrownMatch[1], 10));
                            if (rangeMatch) currentRange = Math.max(currentRange, parseInt(rangeMatch[1], 10));

                            // Treat basic melee/reach as 5ft if no specific number found but keyword exists
                            if (currentRange === 0 && (details.toLowerCase().includes('reach') || details.toLowerCase().includes('melee'))) {
                                currentRange = 5;
                            }

                            if (currentRange < shortestRange) {
                                shortestRange = currentRange;
                                shortestRangeStrikeName = strike.name;
                            }
                        }
                        referencedStrikeName = shortestRangeStrikeName; // Could still be null if no strikes have range > 0
                    }

                    // 3. Append the reference if found
                    if (referencedStrikeName) {
                        effectText += ` (Damage based on Strike: ${referencedStrikeName})`;
                    }
                }
                // --- End Trample Specific Strike Reference ---


                const triggerDisplay = triggerText ? `\n    Trigger: ${triggerText}` : '';
                const requirementDisplay = requirementText ? `\n    Requirements: ${requirementText}` : '';
                const effectDisplay = effectText ? `\n    Description: ${effectText}` : ''; 
                const frequencyInfo = ability.frequencyText ? ` ${ability.frequencyText}` : '';

                // Construct the main line (Name, Cost, Frequency, Traits)
                entryString = `  - ${ability.name} ${ability.costText || '(?)'}${minRangeText}${frequencyInfo}${ability.traits ? ` [${ability.traits}]` : ''}`;

                // Append Trigger, Requirements, and Desc (Effect) on separate lines if they exist
                entryString += triggerDisplay;
                entryString += requirementDisplay;
                entryString += effectDisplay;

                // Optional fallback log
                if (!triggerText && !requirementText && !effectText && ability.fullDesc) {
                    // console.warn(`AI createList: Action ${ability.name} parsing failed. CleanedDesc: "${ability.fullDesc}"`); // DEBUG
                }
            }

            // --- Format Consumable ---
            else if (listType === 'Consumable') {
                const rangeText = ability.numericRange > 0 ? ` (Range ${ability.numericRange}ft)` : '';
                entryString = `  - ${ability.name} ${ability.costText || '(1a Interact?)'} (Qty: ${ability.quantity})${rangeText}${ability.traits ? ` [${ability.traits}]` : ''}`;
                if (ability.fullDesc && ability.fullDesc.length > 0) { // Check description
                    entryString += `\n    Description: ${ability.fullDesc}`;
                }
            }
            // --- Format Passive Ability ---
            else if (listType === 'Passive Ability') {
                entryString = `  - ${ability.name}${ability.traits ? ` [${ability.traits}]` : ''}`;
                if (ability.fullDesc && ability.fullDesc.length > 0) { // Check description
                    entryString += `\n    Description: ${ability.fullDesc}`;
                }
            }
            // --- Format Combo Setup Action ---
            else if (listType === 'Combo Setup Action') {
                entryString = `  - ${ability.name} ${ability.costText || ''}${ability.traits ? ` [${ability.traits}]` : ''}${ability.frequencyText ? ` ${ability.frequencyText}` : ''}`;
                // Removed range display for combo setup actions as it's usually not relevant
                if (ability.followUpAction) { // Added for combo setup
                    entryString += `\n    Follow-up Required: ${ability.followUpAction}`;
                }
                if (ability.fullDesc && ability.fullDesc.length > 0) { // Check description
                    entryString += `\n    Description: ${ability.fullDesc}`;
                }
            }
            // --- Format Condition/Effect ---
            else if (listType === 'Condition/Effect') {
                entryString = `  - ${ability.name}`;
                if (ability.desc && ability.desc.length > 0) { // Check description
                    entryString += `: ${ability.desc}`;
                }
            }


            output.push(entryString.trim());
        }
        // Removed redundant marker logic from the end
        return output.join('\n\n');
    };

    // Filter ability lists based on the setting before formatting
    const filteredSpells = filterReactionsIfNeeded(gameState.self.spells);
    const filteredFocusSpells = filterReactionsIfNeeded(gameState.self.focusSpells);
    const filteredCantrips = filterReactionsIfNeeded(gameState.self.cantrips); // Cantrips usually aren't reactions, but filter for consistency
    const filteredItemSpells = filterReactionsIfNeeded(gameState.self.itemGrantedSpells);
    const filteredActionsAndActionFeats = filterReactionsIfNeeded(gameState.self._actionsAndActionFeatsList);
    const filteredComboSetupActions = filterReactionsIfNeeded(gameState.self._comboSetupActionsList); // Corrected property access
    const filteredConsumables = filterReactionsIfNeeded(gameState.self.consumables);

    // Generate ability strings using potentially filtered lists
    // Pass gameState to createAbilityListString calls
    const spellsString = createAbilityListString(filteredSpells, 'Leveled Spell', closestEnemyDist, gameState);
    const focusSpellsString = createAbilityListString(filteredFocusSpells, 'Focus Spell', closestEnemyDist, gameState);
    const cantripsString = createAbilityListString(filteredCantrips, 'Cantrip', closestEnemyDist, gameState);
    const itemSpellsString = createAbilityListString(filteredItemSpells, 'Item Spell', closestEnemyDist, gameState);
    const strikesString = createAbilityListString(gameState.self.strikes, 'Strike', closestEnemyDist, gameState);
    const actionsAndActionFeatsString = createAbilityListString(filteredActionsAndActionFeats, 'Action/Feat/Free', closestEnemyDist, gameState);
    const comboSetupActionsString = createAbilityListString(filteredComboSetupActions, 'Combo Setup Action', closestEnemyDist, gameState); // Added combo setup string generation
    const passiveAbilitiesString = createAbilityListString(gameState.self.passiveAbilities, 'Passive Ability', closestEnemyDist, gameState); // Passives don't usually have range, but pass for consistency
    const consumablesString = createAbilityListString(filteredConsumables, 'Consumable', closestEnemyDist, gameState);
    const conditionsEffectsString = createAbilityListString(gameState.self.conditionsEffects, 'Condition/Effect', closestEnemyDist, gameState); // Pass gameState here too for consistency

    const formatCombatantEntry = (c) => { let parts = [`${c.name} (${c.size || 'size?'})`]; parts.push(c.positionString); if (c.distance !== null) parts.push(`Distance: ${c.distance}`); if (c.hpPercent !== null) parts.push(`HP: ${c.hpPercent}%`); if (c.defeated) parts.push('[Defeated]'); if (c.conditionsEffects?.length > 0) { parts.push(`Cond/Effects: ${c.conditionsEffects.map(ce => { const name = ce.name; const value = ce.value; if (value !== null && !String(name).endsWith(` ${value}`)) { return `${name} ${value}`; } return name; }).join(', ')}`); } return `  - ${parts.join(' | ')}`; }; // Check if name already includes value before appending
    const alliesFormatted = gameState.allies?.map(formatCombatantEntry).join('\n') || EMPTY_LIST_PLACEHOLDER;
    const enemiesFormatted = gameState.enemies?.map(formatCombatantEntry).join('\n') || EMPTY_LIST_PLACEHOLDER;


    const skipInstruction = skippedAction ? `\nIMPORTANT NOTE: You previously suggested "${skippedAction}". DO NOT suggest that action again this turn.` : "";
    const manualNotesSection = (manualNotes && manualNotes.trim() !== "") ? `\n**Manual Notes from Player/GM:** ${manualNotes.trim()}` : "";

    // --- Format Interim Results ---
    const interimResultsString = Array.isArray(interimResults) && interimResults.length > 0
        ? `\n- **AI Actions Taken This Turn:**\n${interimResults.map(r => `    - ${r.text}`).join('\n')}` // Renamed for clarity
        : "";
    // --- Format Recent Chat Events ---
    const recentEventsString = Array.isArray(gameState.recentEvents) && gameState.recentEvents.length > 0
        ? `\n- **Events Since Last Action (Chat Log):**\n${gameState.recentEvents.map(e => `    - ${e}`).join('\n')}` // Format recent chat events
        : "";
    console.log(`AI Debug Prompt: recentEventsString: ${recentEventsString || 'None'}`); // DEBUG
    const closestEnemyInfo = closestEnemyDist !== null ? `**Closest Enemy: ${closestEnemyDist}ft**` : "**No Enemies Visible/Tracked**";
    // --- Check for Variable Cost Actions ---
    let hasVariableCostActions = false;
    const checkVariableCost = (item) => typeof item?.costValue === 'string' && item.costValue.includes(' to ');
    if (
        gameState.self?.spells?.some(checkVariableCost) ||
        gameState.self?.focusSpells?.some(checkVariableCost) ||
        gameState.self?.cantrips?.some(checkVariableCost) || // Less likely but check anyway
        gameState.self?.itemGrantedSpells?.some(checkVariableCost) ||
        gameState.self?._actionsAndActionFeatsList?.some(checkVariableCost) ||
        gameState.self?.consumables?.some(checkVariableCost) // Less likely but check anyway
    ) {
        hasVariableCostActions = true;
    }

    const activeStanceSection = gameState.self?.activeStance?.name !== 'None'
        ? `- **Active Stance**: ${gameState.self.activeStance.name}${gameState.self.activeStance.desc ? `\n    Stance Desc: ${gameState.self.activeStance.desc}` : ''}`
        : `- **Active Stance**: None`;
 
    // --- Consolidate Contextual Reminders ---
    let contextualInfo = [];
    // Stance
    if (gameState.hasStanceAction) {
        contextualInfo.push("- **Stance Actions:** If you have Stance actions available (check ACTIONS list), you usually want to enter one before making Strikes. Only one Stance can be active at a time.");
    }
    // Flourish
    if (gameState.hasFlourishAction) {
        contextualInfo.push("- **Flourish Actions:** Actions with the [Flourish] trait are powerful but require finesse. You can use ONLY ONE action with the Flourish trait per turn.");
    }
    // Flanking
    if (gameState.hasAllies) {
        contextualInfo.push("- **Flanking:** You flank an enemy if you and an ally are on opposite sides/corners of its space. Both must be able to act, wield melee weapons/unarmed attacks, not be prevented from attacking, and have the enemy within reach. Flanked enemies are Off-Guard (-2 AC) to melee attacks.");
    }
    // Grab
    if (gameState.hasGrabAttack) {
        contextualInfo.push("- **Grab After Strike:** If your *most recent* action was a successful Strike with Grab/Improved Grab, STRONGLY PRIORITIZE suggesting the 'Grab' action itself (if available) next, unless the target is already Grabbed/Restrained by you.");
    }
    // Sustain
    if (gameState.canSustainSpells) {
        contextualInfo.push("- **Sustain a Spell:** This costs 1 action. ONLY suggest it if an active effect under 'Current Conditions & Effects' comes from a spell with a 'sustained' duration (check spell details).");
    }
    // Variable Cost
    if (gameState.hasVariableCostActions) {
        contextualInfo.push("- **Variable Costs:** Actions/Spells with variable costs (e.g., Heal) require YOU to CHOOSE and specify the exact number of actions (1, 2, or 3) in the ACTION line (e.g., `ACTION: Cast Heal (Rank 3, 2 actions), Target`). Justify the chosen cost in the Rationale.");
    }
    // Heal Guidance
    if (gameState.hasHealSpell) {
        contextualInfo.push("- **Heal Spell Guidance:** 1 action=Touch/weak heal; 2 actions=30ft/strong heal; 3 actions=30ft emanation/weak heal (affects enemies unless undead/negative healing).");
    }
    // Free Action Combos (Conditional)
    if (gameState.hasFreeActions) {
        contextualInfo.push("- **Free Action Combos:** Look for Free Actions (F) like Quickened Casting in the 'ACTIONS' list. **These instructions apply ONLY when combining a Free Action with the action immediately following it.**\n    - **Check Free Action details:** Frequency? Trigger? What does it modify (e.g., reduces cost, adds effect)? E.g., Quickened Casting may only work with spells of specific ranks.\n    - **Check Main Action requirements:** Is it a valid target for the Free Action? Is the Main Action affordable *after* any cost reduction?\n    - **Free Action Combo Format:** ACTION: [Free Action Name] + [Main Action Name] ([Main Action's Final Cost]), [Target]\n    - **Free Action Combo Cost:** COST: must reflect the *final, potentially reduced cost* of the *main action* (e.g., 1 if Quickened reduces a 2-action spell).\n    - **Free Action Combo Rationale:** Explain the combo, the cost reduction/effect, and why it's tactically sound. Mention checking Frequency.\n    - **IMPORTANT:** Do NOT use this combo format for sequential actions like Stride then Strike. Suggest Stride as its own action first if needed (See Movement Need rule).");
    }
    // Spell Ranks/Levels (Conditional)
    if (gameState.hasLeveledSpells) {
        contextualInfo.push("- **Spell Ranks/Levels:** Spells listed show available prepared slots (e.g., \"Prepared Slots: R1x2, R3\") or base rank for spontaneous/focus spells. Cantrips scale automatically.\n    - **CRITICAL: If suggesting a Leveled Spell (not Focus/Cantrip) that can be cast using different rank slots (Spontaneous or Prepared at multiple ranks), YOU MUST specify the chosen Rank in the ACTION line.** Example: \"ACTION: Cast Heal (Rank 3, 2 actions), Ally Name\" (Note: Also includes chosen action count per Variable Cost rule).\n    - **CRITICAL: Your Rationale MUST explain WHY you chose that specific Rank/Level** (e.g., highest available for max effect, lowest available to conserve resources, specific rank needed for effect). Check the 'Prepared Slots' info if relevant.");
    }
    // Format the final string
    const contextualInfoString = contextualInfo.length > 0 ? `\n**Contextual Reminders & Key Rules:**\n${contextualInfo.join('\n')}\n` : '';
    // --- End Contextual Reminders ---
 
    // Assemble Prompt Sections
    let promptSections = [];
    promptSections.push(`
You are ${actor.name}, a ${actor.ancestry?.name || ''} ${actor.class?.name || 'character'} (Size: ${gameState.self?.size || '?'}). It is your turn in combat.
${gameState.self.permanentNotes ? `
**--- Player Provided Character Notes ---**
${gameState.self.permanentNotes.trim()}
**------------------------------------**
` : ''}
${contextualInfoString}

You have ${turnState.actionsRemaining} actions remaining. Your current Multiple Attack Penalty (MAP) is ${mapDisplayString}.
${(() => {
    const stunned = gameState.self?.conditionsEffects?.find(c => c.name.toLowerCase().startsWith('stunned'));
    const slowed = gameState.self?.conditionsEffects?.find(c => c.name.toLowerCase().startsWith('slowed'));
    let note = '';
    if (stunned) {
        note += `\n- **Stunned ${stunned.value ?? '?'}:** You lose ${stunned.value ?? '?'} action(s) at the start of your turn. Reduce the Stunned value by the number of actions lost.`;
    }
    if (slowed) {
        note += `\n- **Slowed ${slowed.value ?? '?'}:** You have ${slowed.value ?? '?'} fewer action(s) at the start of your turn. Actions lost to Stunned count towards this.`;
    }
    if (note) {
        return `\n**IMPORTANT CONDITION REMINDER:**${note}`;
    }
    return '';
})()}

**Primary Goal:** Act tactically to defeat enemies and support allies, using your available actions effectively.
**Consider Future Turns:** Evaluate if a setup action (like moving, buffing, or applying a condition) could enable a more powerful action later.

**Your Current State (${actor.name}):**
- HP: ${gameState.self?.hp?.value}/${gameState.self?.hp?.max} (${gameState.self?.hpPercent}%) | AC: ${gameState.self?.ac} | Speed: ${gameState.self?.speed}
- Focus Points: ${gameState.self?.focusPoints?.value ?? 0} / ${gameState.self?.focusPoints?.max ?? 0}
- Position: ${gameState.self?.coordinates ? `(${gameState.self.coordinates.x}, ${gameState.self.coordinates.y})` : (gameState.self?.position || 'Unknown')}
${activeStanceSection}
- Senses: ${gameState.self?.senses || 'Normal'}
- Defenses: Res: ${gameState.self?.resistances} | Weak: ${gameState.self?.weaknesses} | Imm: ${gameState.self?.immunities}

${conditionsEffectsString !== EMPTY_LIST_PLACEHOLDER ? `
- **Current Conditions & Effects (CRITICAL - Check Descriptions for Restrictions/Impacts):**
${conditionsEffectsString}

--END CONDITIONS
` : ''}

- Your Actions Taken This Turn: ${turnState.actionsTakenDescriptions?.join('; ') || 'None'}

${interimResultsString}${recentEventsString}

**Combat Situation (Round ${combat?.round ?? '?'})**

${closestEnemyInfo}

- **Enemies in Combat (Closest First, Includes Defeated):**
${enemiesFormatted}

- **Allies in Combat (Closest First):**
${alliesFormatted}

${skipInstruction}
${manualNotesSection}

**Other Key Rules & Reminders:**
- **Distance & Range (CRITICAL):** Compare Spell/Ability 'Range'/'Reach' against target 'Distance:'. If Distance > Range, move first. For melee Strikes, check 'Reach' against 'Distance:'. Note the 'Out-of-Range Marker'.
- **Action Costs:** (1a), (2a), (3a), (R)eaction, (F)ree. You have ${turnState.actionsRemaining} actions left. Free actions cost 0 but check Frequency limits.
${turnState.actionsLostToStunnedAtStart > 0 ? `    - **Stunned Reduction:** You lost ${turnState.actionsLostToStunnedAtStart} action(s) to Stunned ${turnState.stunnedValueAtStart} at the start of this turn. Remember to reduce the Stunned condition value by ${turnState.actionsLostToStunnedAtStart}.` : ''}
- **Requirements:** Action/Feat **(Requires: ...)** text MUST be met NOW.
- **Conditions/Effects:** Check carefully for restrictions or opportunities.
- **Passive Abilities:** Context ONLY. Do NOT suggest activating unless also in Actions list.
- **Targeting:** Use names from lists or relative directions. DO NOT use coordinates in ACTION line.
// Removed Spell Ranks/Levels block from here - moved to contextualInfo
**Available Resources & Abilities (Sorted by Descending Range):**
    `); 

    let abilitySections = [];
    if (strikesString !== EMPTY_LIST_PLACEHOLDER) { abilitySections.push(`**Strikes (Bonus reflects Current MAP ${mapDisplayString}):**\n\n${strikesString}`); }
    if (actionsAndActionFeatsString !== EMPTY_LIST_PLACEHOLDER) { abilitySections.push(`**ACTIONS AVAILABLE (Check Requirements & Frequency!):**\n\n${actionsAndActionFeatsString}`); }
    if (comboSetupActionsString !== EMPTY_LIST_PLACEHOLDER) { abilitySections.push(`**COMBO SETUP ACTIONS (Use these to enable the specified follow-up action):**\n\n${comboSetupActionsString}`); } // Added Combo Setup section
    if (consumablesString !== EMPTY_LIST_PLACEHOLDER) { abilitySections.push(`**CONSUMABLES AVAILABLE (Usually 1a Interact; Check Traits/Desc):**\n\n${consumablesString}`); }
    let spellSubSections = [];
    if (spellsString !== EMPTY_LIST_PLACEHOLDER) spellSubSections.push(`- LEVELED SPELLS (Shows base rank and prepared slot ranks - check availability!):\n\n${spellsString}`);
    if (focusSpellsString !== EMPTY_LIST_PLACEHOLDER) spellSubSections.push(`- FOCUS SPELLS (Requires 1 Focus Point):\n\n${focusSpellsString}`);
    if (cantripsString !== EMPTY_LIST_PLACEHOLDER) spellSubSections.push(`- CANTRIPS (Unlimited Uses):\n\n${cantripsString}`);
    if (itemSpellsString !== EMPTY_LIST_PLACEHOLDER) spellSubSections.push(`- ITEM-GRANTED SPELLS (Assume Usable, Check Cost):\n\n${itemSpellsString}`);
    if (spellSubSections.length > 0) { abilitySections.push(`**SPELLS AVAILABLE (Check Cost, Range, Target, Save, Focus Points, AND Available Ranks/Slots):**\n\n${spellSubSections.join('\n\n')}`); }
    // MOVED Passive Abilities addition BEFORE joining abilitySections
    if (passiveAbilitiesString !== EMPTY_LIST_PLACEHOLDER) {
        abilitySections.push(`**PASSIVE ABILITIES & AURAS (Context ONLY - Do Not Suggest as an Action):**\n\n${passiveAbilitiesString}`);
    }
    // Now join and push all sections including passives
    promptSections.push(abilitySections.join(LIST_SEPARATOR));



    promptSections.push(`
 **Tactical Decision Process:**
 1. Assess YOUR Conditions/Effects & Stance. Any restrictions/opportunities?
 2. Review Combat Situation: ${closestEnemyInfo}. Allies/Enemies? HP? Conditions? Flanking possible? Check target Distance/Pos.
 3. **Scan Actions/Feats/Free Actions AND Combo Setup Actions lists.** Any useful Free Actions? Check Frequency. Can a Combo Setup Action enable a desired follow-up? Can a Free Action combine with another?
 4. Consider High-Impact Options: Spell? Ability? Consumable? Combo? Check cost vs. remaining actions (${turnState.actionsRemaining}). **If Spell: Which Rank/Slot is best AND available (Check 'Prepared Slots')?**
    - **Stance Strike Priority:** If you are in a Stance (check 'Active Stance'), STRONGLY consider using the Strike marked with \`(Stance Strike)\` if it's tactically sound (good range, target available).
    - **Choosing the Best Strike for Actions (e.g., Flurry of Blows, Power Attack):** When an action allows you to make a Strike, compare your available Strikes (especially the \`(Stance Strike)\` vs. others like Fist). Choose the Strike that offers the best combination of accuracy (attack bonus) and damage potential (higher damage dice, traits like 'deadly', attack effects like 'Grab'). If accuracy is equal, prioritize the one with higher damage potential. Explicitly state which Strike you chose in the Rationale.
 5. **If considering a variable-cost action (like Heal): Decide the optimal number of actions (1, 2, or 3)** based on the situation (range, targets, effect needed) and the Heal spell guidance provided.
 6. Range/Reach Check:
     - **Verify chosen 'Range'/'Reach' vs. target 'Distance:'. Note the 'Out-of-Range Marker'.** Range must be greater than or equal to the distance to the target.
     - **CRITICAL FOR MULTI-ATTACK/STEP ACTIONS (like Destructive Frenzy): Ensure that you are in EFFECTIVE RANGE of a target. DO NOT USE OTHERWISE.**
     - **Multi-Attack Repositioning:** If considering a multi-attack action (like Flurry of Blows, Double Slice) where the *first* attack is likely to defeat the primary target, evaluate if a Step or Stride *before* the action could position you to use the *second* (or subsequent) attack on a different nearby enemy. Prioritize this repositioning if it efficiently uses all attacks.
 7. Movement Need: If Range/Reach is insufficient for the desired action (including *all required parts* of multi-step actions), **suggest ONLY the necessary movement action (e.g., Stride, Step) for this suggestion.** Explain that this movement enables the desired action for subsequent suggestions/actions this turn. DO NOT combine Stride/Step with another costing action in the same ACTION line unless Stride/Step itself is somehow free.
 8. Setup Check: Value in setup actions (buff, debuff, position)? Consider using a Combo Setup Action if it enables a strong follow-up.
 9. Choose Best Action: Select the single best tactical action OR combo for THIS step. **If a Spell: Specify the chosen Rank. If Variable Cost: Specify the chosen number of actions. If using an action that makes a Strike (like Flurry of Blows): Ensure you've chosen the *best* Strike based on the comparison rule above.**
 10. Final Check: Obeys Conditions, Requirements, Costs, **Frequency**, **Range/Reach**? Rationale clear? **If combo, is output formatted correctly (Action1 + Action2 (FinalCost)) and COST line reflects FINAL cost?** **If Spell: Is Rank included AND justified? If Variable Cost: Is Action Count included AND justified? If action uses a Strike: Is the chosen Strike justified in the Rationale?**
 11. Choose Best Action: Select the single best tactical action OR combo for THIS step. **If a Spell: Specify the chosen Rank. If Variable Cost: Specify the chosen number of actions.**
 12. **MANDATORY FINAL CHECK FOR MULTI-ATTACK ACTIONS:** Before suggesting an action like Destructive Frenzy, **ABSOLUTELY CONFIRM ALL component strike ranges (e.g., Tusk, Foot, Trunk ranges from the STRIKES list) are sufficient to hit the target at its current distance.** If not, DO NOT suggest the action unless also suggesting movement first.
 13. Final Overall Check: Obeys Conditions, Requirements, Costs, **Frequency**, **Range/Reach**? Rationale clear? **If combo, is output formatted correctly (Action1 + Action2 (FinalCost)) and COST line reflects FINAL cost?** **If Spell: Is Rank included AND justified? If Variable Cost: Is Action Count included AND justified? If action uses a Strike: Is the chosen Strike justified in the Rationale?**

 **Task:** Describe the single NEXT best action or combo for ${actor.name} to take. Be specific about the action and the target(s). Use combo format if applicable. **If suggesting a Leveled Spell with rank choices, INCLUDE the chosen Rank.** **If suggesting a variable-cost action (like Heal), INCLUDE the chosen number of actions (e.g., "(2 actions)").** Also provide a brief, flavorful narrative summary of the action.
 **Output Format (Strict):**
 ACTION: [Action Name OR FreeAction + MainAction (FinalCost) OR Action Name (X actions) OR Spell Name (Rank X, Y actions)], [Target Name/Relative Direction/Self/Area Description]
 COST: [Number (1, 2, or 3), R, or F reflecting the FINAL cost of the main action in a combo OR the chosen number of actions for a variable action]
 Rationale: [Brief explanation. CRITICAL: If moving, state why. If attacking, check range/reach. If combo, explain it & cost reduction & Frequency check. Mention key conditions/rules considered. **If Spell with rank choice: Justify chosen Rank/Level.** **If Variable Cost action: Justify chosen number of actions (1, 2, or 3).** **If action uses a Strike (e.g., Flurry of Blows): Justify the chosen Strike (e.g., "Using Tiger Claw (Stance Strike) for higher damage").**]
 NARRATIVE: [A short, engaging, action-packed sentence describing the action being taken.]

ACTION:
COST:
Rationale:
NARRATIVE:`); // End of last push

    return promptSections.join('\n');
}

/**
 * Crafts a prompt specifically asking the LLM to generate a narrative summary of the completed turn.
 * @param {object} combatant - The combatant whose turn just ended.
 * @param {string[]} actionsTakenDescriptions - List of intended actions (from turnState).
 * @param {string[]} recentEvents - List of actual outcomes/events (from gameState).
 * @returns {string} The prompt string for the LLM.
 */
function craftTurnSummaryPrompt(combatant, actionsTakenDescriptions, recentEvents) {
    const actor = combatant?.actor;
    if (!actor) return "Error: Cannot generate summary prompt without actor.";

    const actionsList = actionsTakenDescriptions?.length > 0
        ? actionsTakenDescriptions.map(a => {
            // Clean up UUIDs like @UUID[...]{Description} -> Description
            const cleanedAction = a.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, '$1');
            return `- ${cleanedAction}`;
          }).join('\n')
        : "- No specific actions were recorded.";

    const eventsList = recentEvents?.length > 0
        ? recentEvents.map(e => `- ${e}`).join('\n')
        : "- No significant events were recorded.";

    return `
You are narrating the end of ${actor.name}'s turn in combat.

**Instructions:** Write a short, engaging, and flavorful narrative summary (1-3 sentences) describing what happened during ${actor.name}'s turn. Use the information below to make the narrative exciting and accurate. Focus on the *outcomes* and paint a picture of the action.

**Intended Actions This Turn:**
${actionsList}

**Actual Outcomes & Events This Turn:**
${eventsList}

**Narrative Summary Task:**
- Synthesize the intended actions and actual outcomes into a cohesive story of the turn.
- Emphasize significant results: Did attacks hit or miss? Were there critical hits or fumbles? Did spells succeed or fail?
- Make it sound dynamic and exciting, like a narrator describing the scene.
- Keep it concise (1-3 sentences).
- **Output ONLY the narrative summary text.** Do NOT include prefixes like "Narrative Summary:".

**Example (if attacks missed):** "${actor.name} lunged forward, but their attacks went wide, failing to connect with the enemy."
**Example (if spell succeeded):** "Gathering arcane energy, ${actor.name} unleashed a powerful spell, engulfing the target in flames!"
**Example (if mixed results):** "${actor.name} moved into position and struck twice; the first blow glanced off harmlessly, but the second found its mark!"

**Narrative Summary (Output ONLY the text below this line):**
`;
}


// `callLLM`: Calls the API.
async function callLLM(prompt, apiKey, endpoint, model = "gpt-4o") {
    // console.debug(`PF2e AI Combat Assistant | --- Calling LLM API (${model}) ---`); // DEBUG
    if (!prompt || !apiKey || !endpoint || !model) {
        console.error("PF2e AI Combat Assistant | LLM call aborted: Missing parameters (prompt, apiKey, endpoint, or model).");
        ui.notifications.error("AI Assistant: LLM call aborted due to missing configuration. Check module settings and console (F12).", { permanent: true });
        return null;
    }
    console.log(`PF2e AI Combat Assistant | Sending prompt to ${model} at ${endpoint}. Prompt length: ${prompt.length}`); // Log prompt length
    try {
        const response = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], temperature: 0.6, max_tokens: 180, stop: null }) // Note: max_tokens might be low for some models/tasks
        });

        if (!response.ok) {
            let errorBodyText = `Status: ${response.status} ${response.statusText}`;
            try {
                const body = await response.text();
                errorBodyText += `. Body: ${body.substring(0, 500)}${body.length > 500 ? '...' : ''}`; // Limit logged body length
            } catch (bodyError) {
                errorBodyText += ` (Could not read error response body: ${bodyError})`;
            }
            console.error(`PF2e AI Combat Assistant | LLM API HTTP Error: ${errorBodyText}`);
            throw new Error(`LLM API Error (${response.status}). Check console (F12) for details.`); // Throw a user-friendlier message
        }

        const responseData = await response.json();
        const messageContent = responseData.choices?.[0]?.message?.content;

        if (!messageContent) {
            console.warn("PF2e AI Combat Assistant | LLM response successful, but no message content found:", responseData);
            // Optionally notify user about empty response
            // ui.notifications.warn("AI Assistant: Received an empty response from the LLM.");
            return null;
        }
        return messageContent.trim();

    } catch (error) {
        // Log more detailed error information
        console.error(`PF2e AI Combat Assistant | Error during LLM API call.`);
        console.error(`> Endpoint: ${endpoint}`);
        console.error(`> Model: ${model}`);
        console.error(`> Prompt Length: ${prompt?.length ?? 'N/A'}`);
        console.error(`> Error Details:`, error); // Log the full error object

        // User-facing notification
        ui.notifications.error(`AI Assistant: Error communicating with the LLM. Check the console (F12) for details. Common issues: incorrect API key/endpoint/model, network problems, or insufficient token context length.`, { permanent: true });

        throw error; // Re-throw so the calling function knows it failed
    }
}

// `parseLLMSuggestion`: Parses LLM response.
function parseLLMSuggestion(responseString) {
    if (!responseString || typeof responseString !== 'string') {
        console.error("PF2e AI Combat Assistant | LLM Parser received null/invalid string.");
        return null;
    }
    let parsedAction = null;
    let parsedCost = null;
    let parsedRationale = null;
    let parsedNarrative = null; // Added for narrative

    // Trim leading/trailing whitespace and potential leading hyphens
    responseString = responseString.trim().replace(/^-\s*/, '');

    // Regex to capture ACTION, COST, Rationale, and NARRATIVE, allowing for optional markdown and flexible order
    const actionMatch = responseString.match(/(?:^|\n)\s*\**ACTION:\**\s*(.*?)(?=\s*\n\s*\**(?:COST:|Rationale:|NARRATIVE:)|$)/is);
    const costMatch = responseString.match(/(?:^|\n)\s*\**COST:\**\s*(\d+|R|F)(?:\s*action[s]?)?/i);
    const rationaleMatch = responseString.match(/(?:^|\n)\s*\**Rationale:\**\s*(.*?)(?=\s*\n\s*\**(?:ACTION:|COST:|NARRATIVE:)|$)/is);
    const narrativeMatch = responseString.match(/(?:^|\n)\s*\**NARRATIVE:\**\s*(.*)/is); // Capture narrative

    // --- Primary Parsing Strategy (Using Regex) ---
    if (actionMatch?.[1] && costMatch?.[1]) {
        parsedAction = actionMatch[1].trim();
        const costString = costMatch[1].toUpperCase();
        if (costString === 'R' || costString === 'F') {
            parsedCost = costString;
        } else {
            const numericCost = parseInt(costString, 10);
            if (!isNaN(numericCost) && numericCost >= 1 && numericCost <= 3) {
                parsedCost = numericCost;
            }
        }
        parsedRationale = rationaleMatch?.[1]?.trim() || null;
        parsedNarrative = narrativeMatch?.[1]?.trim() || null; // Parse narrative

        // Clean up potential cross-contamination if regex didn't perfectly separate
        if (parsedAction && parsedCost !== null) {
            parsedAction = parsedAction.replace(/\**COST:.*$/i, '').replace(/\**Rationale:.*$/i, '').replace(/\**NARRATIVE:.*$/i, '').trim();
            if (parsedRationale) parsedRationale = parsedRationale.replace(/\**ACTION:.*$/i, '').replace(/\**COST:.*$/i, '').replace(/\**NARRATIVE:.*$/i, '').trim();
            if (parsedNarrative) parsedNarrative = parsedNarrative.replace(/\**ACTION:.*$/i, '').replace(/\**COST:.*$/i, '').replace(/\**Rationale:.*$/i, '').trim();

            return { description: parsedAction, cost: parsedCost, rationale: parsedRationale, narrative: parsedNarrative }; // Return narrative
        }
    }

    // --- Fallback Parsing Strategy (Line-by-Line) ---
    // This is less robust but can handle cases where regex fails due to formatting variations
    const lines = responseString.split('\n');
    let potentialAction = null;
    let potentialCost = null;
    let potentialRationale = null;
    let potentialNarrative = null; // Added for narrative

    for (const line of lines) {
        const trimmedLine = line.trim();
        const actionLineMatch = trimmedLine.match(/^\**ACTION:\**\s*(.*)/i);
        const costLineMatch = trimmedLine.match(/^\**COST:\**\s*(\d+|R|F)(?:\s*action[s]?)?/i);
        const rationaleLineMatch = trimmedLine.match(/^\**Rationale:\**\s*(.*)/i);
        const narrativeLineMatch = trimmedLine.match(/^\**NARRATIVE:\**\s*(.*)/i); // Added for narrative

        if (actionLineMatch?.[1] && !potentialAction) potentialAction = actionLineMatch[1].trim();
        if (costLineMatch?.[1] && potentialCost === null) {
            const costStr = costLineMatch[1].toUpperCase();
            if (costStr === 'R' || costStr === 'F') potentialCost = costStr;
            else if (!isNaN(parseInt(costStr, 10)) && parseInt(costStr, 10) >= 1 && parseInt(costStr, 10) <= 3) potentialCost = parseInt(costStr, 10);
        }
        if (rationaleLineMatch?.[1] && !potentialRationale) potentialRationale = rationaleLineMatch[1].trim();
        if (narrativeLineMatch?.[1] && !potentialNarrative) potentialNarrative = narrativeLineMatch[1].trim(); // Added for narrative
    }

    if (potentialAction && potentialCost !== null) {
        // Ensure narrative is at least an empty string if not found
        potentialNarrative = potentialNarrative || '';
        return { description: potentialAction, cost: potentialCost, rationale: potentialRationale, narrative: potentialNarrative }; // Return narrative
    } else if (potentialAction && potentialCost === null) {
        // If action found but cost is missing/invalid, default cost to 1
        // console.warn(`AI Parse (Fallback): Parsed Action "${potentialAction}" but Cost missing/invalid. Defaulting cost to 1.`); // DEBUG
        potentialNarrative = potentialNarrative || ''; // Ensure narrative is at least an empty string
        return { description: potentialAction, cost: 1, rationale: potentialRationale, narrative: potentialNarrative }; // Return narrative
    }

    // --- Final Failure ---
    console.error(`PF2e AI Combat Assistant | LLM response failed all parsing strategies. Raw response: "${responseString}"`);
    return null;
}

// `generateSuggestionButtons`: Creates buttons for suggestions, removing "Show Item".
function generateSuggestionButtons(options) {
    const {
        combatantId, cost, authoritativeCostString, encodedDesc, actor,
        isSpellSuggestion, spellIdForButton, entryIdForButton, spellNameForButton, spellImageUrl, spellLinkUUID, spellIsItem, spellRankForButton, // Added spellRankForButton
        isStrikeSuggestion, strikeIdentifierForButton, strikeNameForButton, strikeImageUrl, strikeLinkUUID,
        isGenericActionSuggestion, actionUUIDForLink, actionNameForLink, actionImageUrl, includesStrike, stanceEffectUUID, originatingItemIdForStrike, // Added originatingItemIdForStrike
        isConsumableSuggestion, consumableNameForButton, consumableImageUrl, consumableItemUUID,
        isCombo
    } = options;

    if (!combatantId) { console.error("PF2e AI Combat Assistant | generateSuggestionButtons called without combatantId!"); return { primary: '', secondary: '' }; }

    let primaryButtonsHTML = ''; let secondaryButtonsHTML = '';
    const gmOnlyTitle = game.user.isGM ? '' : ' (GM Only)'; const disableForPlayer = !game.user.isGM ? 'disabled' : '';

    // --- Cast Spell Button ---
    if (isSpellSuggestion) {
        const iconHTML = spellImageUrl ? `<img src="${spellImageUrl}" width="16" height="16" style="vertical-align: middle; border:none;" alt="${spellNameForButton || 'Spell'}"/>` : `<i class="fas fa-wand-sparkles"></i>`;
        // Attempt to extract rank from options or UUID for the button data
        const spellRankForButton = options.spellRankForButton || spellLinkUUID?.match(/rank-(\d+)/i)?.[1] || '?'; // Extract rank from options or UUID
        const spellDataAttributes = spellIsItem
            ? `data-spell-uuid="${spellLinkUUID}" data-spell-rank="${spellRankForButton}"` // Item spells - ADDED data-spell-rank
            : `data-spell-id="${spellIdForButton}" data-entry-id="${entryIdForButton}" data-spell-uuid="${spellLinkUUID}" data-spell-rank="${spellRankForButton}"`; // Add spell rank

        // Handle variable cost display
        const castButtonLabel = (typeof authoritativeCostString === 'string' && authoritativeCostString.includes('to'))
            ? `Cast (${authoritativeCostString.replace(' to ', '-')})`
            : "Cast";
        const buttonTitle = isCombo ? `Cast ${spellNameForButton || 'Spell'} (Main part of combo)${gmOnlyTitle}` : `Cast ${spellNameForButton || 'Spell'} via Spellcasting Entry${gmOnlyTitle}`;
        primaryButtonsHTML += `<button class="ai-cast-spell" data-combatant-id="${combatantId}" ${spellDataAttributes} title="${buttonTitle}" ${disableForPlayer}>${iconHTML} ${castButtonLabel}</button>`;
    }
    // --- Execute Strike Button ---
    else if (isStrikeSuggestion && strikeIdentifierForButton) { // Changed to else if
        const iconHTML = strikeImageUrl ? `<img src="${strikeImageUrl}" width="16" height="16" style="vertical-align: middle; border:none;" alt="${strikeNameForButton || 'Strike'}"/>` : `<i class="fas fa-fist-raised"></i>`;
        const buttonTitle = isCombo ? `Roll ${strikeNameForButton || 'Strike'} Attack (Main part of combo)${gmOnlyTitle}` : `Roll ${strikeNameForButton || 'Strike'} Attack (uses current MAP)${gmOnlyTitle}`;
        primaryButtonsHTML += `<button class="ai-execute-strike" data-combatant-id="${combatantId}" data-strike-identifier="${strikeIdentifierForButton}" data-originating-item-id="${originatingItemIdForStrike || ''}" title="${buttonTitle}" ${disableForPlayer}>${iconHTML} Strike</button>`;
    }
    // --- Execute Strike as part of another Action ---
    else if (isGenericActionSuggestion && includesStrike && !isCombo && actor) {
        // Find the best *ready* strike to associate with the action button
        const strikeActions = actor.system.actions?.filter(a => a.type === 'strike' && a.ready);
        const strikeToUse = strikeActions?.sort((a, b) => (b.variants[0]?.bonus ?? -99) - (a.variants[0]?.bonus ?? -99))[0]; // Prioritize highest bonus ready strike

        if (strikeToUse) {
            const strikeIdentifier = strikeToUse.slug || strikeToUse.label; // Use slug if available
            const strikeName = strikeToUse.label || 'Strike';
            const strikeIconUrl = strikeToUse.imageUrl || 'icons/svg/mystery-man.svg';
            const iconHTML = strikeIconUrl ? `<img src="${strikeIconUrl}" width="16" height="16" style="vertical-align: middle; border:none;" alt="${strikeName}"/>` : `<i class="fas fa-fist-raised"></i>`;
            primaryButtonsHTML += `<button class="ai-execute-strike" data-combatant-id="${combatantId}" data-strike-identifier="${strikeIdentifier}" data-originating-item-id="${originatingItemIdForStrike || ''}" title="Roll ${strikeName} (Part of ${actionNameForLink || 'Action'})${gmOnlyTitle}" ${disableForPlayer}>${iconHTML} Strike Component</button>`;
        } else {
            // console.warn(`PF2e AI Combat Assistant | Action "${actionNameForLink}" includes strike, but couldn't find suitable ready strike action.`); // DEBUG
            // Optionally add a generic confirm button here if no strike found? Or rely on the main confirm button below.
        }
    }
    // Confirm Action Button
    primaryButtonsHTML += `<button class="ai-confirm-action" data-combatant-id="${combatantId}" data-action-cost="${cost}" data-action-desc="${encodedDesc}" title="Confirm action taken (Updates AI state ONLY - Reduces actions, may increase MAP)"><i class="fas fa-check"></i> Confirm</button>`;
    // Skip Suggestion Button
    secondaryButtonsHTML += `<button class="ai-skip-action" data-combatant-id="${combatantId}" data-action-desc="${encodedDesc}" title="Skip this suggestion and request another from the AI"><i class="fas fa-forward"></i> Skip</button>`;
    // End AI Turn Button
    secondaryButtonsHTML += `<button class="ai-end-turn" data-combatant-id="${combatantId}" title="End AI control for this combatant's turn"><i class="fas fa-stop"></i> End Turn</button>`;

    return { primary: primaryButtonsHTML, secondary: secondaryButtonsHTML };
}

/**
 * Identifies actions within a suggestion string, links them using UUIDs,
 * and determines the primary action for costing and execution buttons.
 * Uses a robust matching strategy based on known actor items.
 *
 * @param {string} description - The raw suggestion string from the LLM.
 * @param {ActorPF2e} actor - The actor performing the action.
 * @param {object} gameState - The gathered game state.
 * @returns {Promise<object>} An object containing identification results.
 */
async function identifySuggestionTypeAndCost(description, actor, gameState) {
    // Clean the input description
    let cleanedDescription = description || "";
    if (typeof cleanedDescription === 'string') {
        cleanedDescription = cleanedDescription.trim().replace(/\s+a$/i, '').trim();
        // Remove surrounding quotes if present
        if ((cleanedDescription.startsWith('"') && cleanedDescription.endsWith('"')) || (cleanedDescription.startsWith("'") && cleanedDescription.endsWith("'"))) {
            cleanedDescription = cleanedDescription.substring(1, cleanedDescription.length - 1);
        }
        // Remove trailing punctuation often added by LLM
        cleanedDescription = cleanedDescription.replace(/[.,;:]\s*$/, '').trim();
        // Remove specific action indicators if they are the only thing left
        cleanedDescription = cleanedDescription.replace(/^(Cast|Activate|Use|Strike:?)\s+/i, '').trim();
    } else {
        cleanedDescription = "";
    }

    // Initialize result object
    let overallResult = {
        isSpellSuggestion: false, spellIdForButton: null, entryIdForButton: null, spellNameForButton: null, spellImageUrl: null, spellLinkUUID: null, spellIsItem: false, spellRankForButton: null, // Added spellRankForButton
        isStrikeSuggestion: false, strikeIdentifierForButton: null, strikeNameForButton: null, strikeImageUrl: null, strikeLinkUUID: null,
        isGenericActionSuggestion: false, actionUUIDForLink: null, actionNameForLink: null, actionImageUrl: null, stanceEffectUUID: null, includesStrike: false, originatingItemIdForStrike: null, // Added originatingItemIdForStrike
        isConsumableSuggestion: false, consumableNameForButton: null, consumableImageUrl: null, consumableItemUUID: null,
        actualActionCost: null, costSource: "LLM", traits: [],
        modifiedDescriptionWithActionLink: cleanedDescription, // Default to cleaned original
        isCombo: false
    };

    const actorName = actor?.name || 'Unknown Actor';
    if (!cleanedDescription) return overallResult; // Nothing to process

    // --- 1. Compile and Sort Master List of Linkable Items (using gameState if available) ---
    const getMasterList = () => {
        const list = [];
        const safeGetList = (key) => gameState?.self?.[key] ?? [];
        // Use helper to add items, now includes entryId for spells
        const addToList = (items, type) => {
            if (!Array.isArray(items)) return;
            items.forEach(item => {
                if (!item) return; // Skip null/undefined items
                const name = item.name || item.label; // Use name or label
                const uuid = item.uuid || (item.originalItemData ? item.originalItemData.uuid : null) || (item.item ? item.item.uuid : null);
                if (typeof name === 'string' && uuid) {
                    // Extract necessary data based on type
                    let entryId = null; let id = null; let identifier = null; let img = null;
                    if (type === 'spell') {
                        entryId = item.entryId;
                        id = item.id;
                        img = item.img || "icons/svg/book.svg"; // Default spell icon
                    } else if (type === 'strike') {
                        id = item.itemId;
                        identifier = item.identifier;
                        img = item.imageUrl || "icons/svg/combat.svg"; // Default strike icon
                    } else if (type === 'action') {
                        id = item.id;
                        img = item.img || "icons/svg/action.svg"; // Default action icon
                    } else if (type === 'consumable') {
                        id = item.id;
                        img = item.img || "icons/svg/item.svg"; // Default item icon
                    }

                    list.push({
                        name: name, uuid: uuid, type: type,
                        id: id, // Store Item ID (for spells, actions, consumables)
                        entryId: entryId, // Store Spell Entry ID
                        identifier: identifier, // Store Strike Identifier (slug)
                        img: img,
                        originalItemData: item
                    });
                }
            });
        };

        // Add from gameState first if available
        addToList(safeGetList('spells'), 'spell');
        addToList(safeGetList('focusSpells'), 'spell');
        addToList(safeGetList('cantrips'), 'spell');
        addToList(safeGetList('itemGrantedSpells'), 'spell');
        addToList(safeGetList('strikes'), 'strike');
        addToList(safeGetList('_actionsAndActionFeatsList'), 'action');
        addToList(safeGetList('consumables'), 'consumable');

        // Add direct actor items as fallbacks if gameState is missing/empty
        const addFallback = (actorItems, type) => {
            if (!list.some(i => i.type === type) && actorItems) {
                actorItems.forEach(item => {
                    if (item && typeof item.name === 'string' && item.uuid && !list.some(i => i.uuid === item.uuid)) {
                        let entryId = null; let id = null; let identifier = null; let img = null;
                        if (type === 'spell') { entryId = item.system?.location?.value; id = item.id; img = item.img; }
                        else if (type === 'strike') { identifier = item.slug; img = item.imageUrl; id = item.itemId; } // Note: strike data structure differs
                        else { id = item.id; img = item.img; }
                        list.push({ name: item.name, uuid: item.uuid, type: type, id: id, entryId: entryId, identifier: identifier, img: img, originalItemData: item });
                    }
                });
            }
        };
        addFallback(actor.itemTypes.spell, 'spell');
        // Fallback for strikes needs careful handling of actor.system.actions vs itemTypes.weapon
        if (!list.some(i => i.type === 'strike') && actor.system?.actions) {
            actor.system.actions.filter(a => a.type === 'strike').forEach(strike => {
                if (strike && typeof strike.label === 'string' && (strike.item?.uuid || strike.uuid) && !list.some(i => i.uuid === (strike.item?.uuid || strike.uuid))) {
                    list.push({ name: strike.label, uuid: strike.item?.uuid || strike.uuid, type: 'strike', id: strike.itemId, identifier: strike.slug, img: strike.imageUrl, originalItemData: strike });
                }
            });
        }
        addFallback([...actor.itemTypes.action, ...actor.itemTypes.feat], 'action');
        addFallback(actor.itemTypes.consumable, 'consumable');

        // Remove duplicates based on UUID
        const uniqueList = Array.from(new Map(list.map(item => [item.uuid || item.name, item])).values());

        // Sort by name length descending
        uniqueList.sort((a, b) => b.name.length - a.name.length);
        // console.log(`AI Identify: Compiled master list with ${uniqueList.length} unique items.`); // DEBUG
        return uniqueList;
    };

    const masterItemList = getMasterList();

    // --- 2. Find Potential Matches in Description ---
    let potentialMatches = [];
    const descriptionLower = cleanedDescription.toLowerCase();
    const actionNameMatch = cleanedDescription.match(/^([\w\s'-]+)(?:\s*\(.*?\))?(?:\s*,?\s+.*)?$/i); // Match the potential action name at the start
    const primaryActionName = actionNameMatch ? actionNameMatch[1].trim() : cleanedDescription; // Use matched name or whole string
    const primaryActionNameLower = primaryActionName.toLowerCase();

    // --- SPECIAL CASE: Flurry of Blows ---
    // If the suggestion is Flurry of Blows, treat it as a Strike using the best *eligible* attack (unarmed or weapon with 'monk' trait).
    if (primaryActionNameLower === 'flurry of blows') {
        const eligibleStrikes = gameState?.self?.strikes?.filter(s => s.traits?.includes('unarmed') || s.traits?.includes('monk')) || [];

        // Helper function to estimate average damage from a formula string (simplified)
        const estimateAverageDamage = (formula) => {
            if (!formula || typeof formula !== 'string') return 0;
            let averageDamage = 0;
            try {
                // Match dice parts like '2d8'
                const diceRegex = /(\d+)d(\d+)/g;
                let match;
                while ((match = diceRegex.exec(formula)) !== null) {
                    const numDice = parseInt(match[1], 10);
                    const dieSize = parseInt(match[2], 10);
                    if (!isNaN(numDice) && !isNaN(dieSize) && dieSize > 0) {
                        averageDamage += numDice * (dieSize + 1) / 2;
                    }
                }
                // Match flat modifiers like '+5' or '-2' (ensure they are not part of dice)
                const flatRegex = /([+-]\s*\d+)(?!d)/g;
                 while ((match = flatRegex.exec(formula)) !== null) {
                    const flatValue = parseInt(match[1].replace(/\s/g, ''), 10);
                    if (!isNaN(flatValue)) {
                        averageDamage += flatValue;
                    }
                }
                 // Handle cases with only flat damage (e.g., "+3") or just a number
                if (averageDamage === 0 && /^[+-]?\s*\d+$/.test(formula.trim())) {
                    const flatValue = parseInt(formula.replace(/\s/g, ''), 10);
                    if (!isNaN(flatValue)) averageDamage = flatValue;
                }
            } catch (e) {
                console.warn(`AI estimateAverageDamage: Error parsing formula "${formula}": ${e}`);
                return 0; // Return 0 on error
            }
            return averageDamage > 0 ? averageDamage : 0; // Ensure non-negative
        };

        // Sort by highest attack bonus (primary), then highest average damage (secondary) using the calculated damage string
        eligibleStrikes.sort((a, b) => {
            // Extract base bonus from the 'bonuses' string (e.g., "+21 / +17 / +13")
            const parseBaseBonus = (bonusString) => {
                if (!bonusString || typeof bonusString !== 'string') return -99;
                const firstBonus = bonusString.split('/')[0]?.trim();
                const bonusValue = parseInt(firstBonus, 10);
                return isNaN(bonusValue) ? -99 : bonusValue;
            };
            const bonusA = parseBaseBonus(a.bonuses);
            const bonusB = parseBaseBonus(b.bonuses);

            if (bonusA !== bonusB) {
                return bonusB - bonusA; // Higher bonus first
            }

            // If bonuses are equal, compare average damage using the final 'damage' string from gameState
            const damageFormulaA = a.damage; // Use the calculated damage string
            const damageFormulaB = b.damage; // Use the calculated damage string
            const avgDamageA = estimateAverageDamage(damageFormulaA);
            const avgDamageB = estimateAverageDamage(damageFormulaB);
            // console.log(`DEBUG Flurry Sort: Comparing ${a.name} (AvgDmg: ${avgDamageA} from "${damageFormulaA}") vs ${b.name} (AvgDmg: ${avgDamageB} from "${damageFormulaB}")`); // DEBUG
            return avgDamageB - avgDamageA; // Higher average damage first
        });

        const bestEligibleStrike = eligibleStrikes[0];

        if (bestEligibleStrike) {
            // console.log(`AI Identify: Detected Flurry of Blows. Using best eligible strike: "${bestEligibleStrike.label || bestEligibleStrike.name}"`); // DEBUG
            overallResult.isStrikeSuggestion = true;
            overallResult.strikeIdentifierForButton = bestEligibleStrike.identifier || bestEligibleStrike.slug || bestEligibleStrike.label; // Use best available identifier
            overallResult.strikeNameForButton = bestEligibleStrike.label || bestEligibleStrike.name;
            overallResult.strikeImageUrl = bestEligibleStrike.imageUrl || 'icons/svg/combat.svg';
            overallResult.strikeLinkUUID = bestEligibleStrike.uuid || bestEligibleStrike.item?.uuid; // UUID of the weapon/item
            overallResult.actualActionCost = 1; // Flurry costs 1 action
            overallResult.costSource = "Flurry of Blows Rule";
            // Ensure 'attack' and 'flurry' traits are present (Flurry grants the flurry trait), merge with existing traits, remove duplicates
            overallResult.traits = ['attack', 'flurry', ...(bestEligibleStrike.traits || [])].filter((v, i, a) => a.indexOf(v) === i);
            overallResult.modifiedDescriptionWithActionLink = `Flurry of Blows (using ${bestEligibleStrike.label || bestEligibleStrike.name})`; // Update description slightly

            // Return early to prevent generic matching
            return overallResult;
        } else {
            console.warn(`PF2e AI Combat Assistant | Flurry of Blows suggested for ${actorName}, but no eligible (unarmed or monk trait) strike found in gameState.`);
            // Fall through to generic matching as a fallback
        }
    }
    // --- END SPECIAL CASE ---

    masterItemList.forEach(item => {
        const itemNameLower = item.name.toLowerCase();
        // Prioritize exact match or match at the beginning of the primary action part
        if (primaryActionNameLower === itemNameLower || primaryActionNameLower.startsWith(itemNameLower + " ")) {
            // Check word boundary after the match within the primary name
            const endIndex = itemNameLower.length;
            const afterChar = endIndex >= primaryActionNameLower.length ? ' ' : primaryActionNameLower[endIndex];
            const wordBoundaryRegex = /[\s"',.:;+()[\]{}]/;
            if (wordBoundaryRegex.test(afterChar)) {
                potentialMatches.push({
                    startIndex: 0, // Assume it's the primary action at the start
                    endIndex: endIndex,
                    uuid: item.uuid, itemName: item.name, itemType: item.type, itemImg: item.img,
                    itemId: item.id, entryId: item.entryId, strikeIdentifier: item.identifier, nameLength: item.name.length
                });
                // console.log(`AI Identify: Found potential PRIMARY match "${item.name}"`); // DEBUG
            }
        }
        // Also check for matches anywhere else in the description for linking secondary actions/targets later (less strict)
        let searchIndex = 0; let startIndex = -1;
        while ((startIndex = descriptionLower.indexOf(itemNameLower, searchIndex)) !== -1) {
            const endIndex = startIndex + itemNameLower.length;
            const beforeChar = startIndex === 0 ? ' ' : descriptionLower[startIndex - 1];
            const afterChar = endIndex === descriptionLower.length ? ' ' : descriptionLower[endIndex];
            const wordBoundaryRegex = /[\s"',.:;+()[\]{}]/;
            if (wordBoundaryRegex.test(beforeChar) && wordBoundaryRegex.test(afterChar)) {
                // Add secondary matches only if they weren't the primary match already
                if (!potentialMatches.some(pm => pm.uuid === item.uuid && pm.startIndex === 0)) {
                    potentialMatches.push({
                        startIndex: startIndex, endIndex: endIndex, uuid: item.uuid, itemName: item.name, itemType: item.type, itemImg: item.img,
                        itemId: item.id, entryId: item.entryId, strikeIdentifier: item.identifier, nameLength: item.name.length
                    });
                    // console.log(`AI Identify: Found potential SECONDARY match "${item.name}" at index ${startIndex}`); // DEBUG
                }
            }
            searchIndex = startIndex + 1;
        }
    });

    // --- 3. Resolve Overlaps (Prioritize Primary > Longer > Earlier) ---
    let confirmedMatches = [];
    let coveredIndices = new Set();

    // Sort potentials: Primary (startIndex 0) first, then prefer spells if rank indicated, then by length descending, then by start index ascending
    const descriptionIndicatesRank = /\(Rank \d+\)/i.test(cleanedDescription); // Check original cleaned description for rank
    potentialMatches.sort((a, b) => {
        // Priority 1: Primary action (starts at 0)
        if (a.startIndex === 0 && b.startIndex !== 0) return -1;
        if (a.startIndex !== 0 && b.startIndex === 0) return 1;

        // Priority 2: If description has Rank X and names match, prefer spell type
        if (descriptionIndicatesRank && a.itemName.toLowerCase() === b.itemName.toLowerCase()) { // Compare names case-insensitively
             if (a.itemType === 'spell' && b.itemType !== 'spell') return -1; // a (spell) comes before b (not spell)
             if (a.itemType !== 'spell' && b.itemType === 'spell') return 1;  // b (spell) comes before a (not spell)
        }

        // Priority 3: Longer name
        if (a.nameLength !== b.nameLength) return b.nameLength - a.nameLength;

        // Priority 4: Earlier start index
        return a.startIndex - b.startIndex;
    });

    potentialMatches.forEach(match => {
        let overlaps = false;
        for (let i = match.startIndex; i < match.endIndex; i++) {
            if (coveredIndices.has(i)) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) {
            confirmedMatches.push(match);
            for (let i = match.startIndex; i < match.endIndex; i++) {
                coveredIndices.add(i);
            }
            // console.log(`AI Identify: Confirmed match "${match.itemName}" [${match.startIndex}-${match.endIndex}]`); // DEBUG
        } else {
            // console.log(`AI Identify: Discarded overlapping match "${match.itemName}" [${match.startIndex}-${match.endIndex}]`); // DEBUG
        }
    });

    // --- 4. Build Linked String ---
    let linkedDescriptionBuilder = [];
    let lastIndexProcessed = 0;
    // Re-sort confirmed matches by start index for building the string
    confirmedMatches.sort((a, b) => a.startIndex - b.startIndex);

    confirmedMatches.forEach(match => {
        if (match.startIndex > lastIndexProcessed) {
            linkedDescriptionBuilder.push(cleanedDescription.substring(lastIndexProcessed, match.startIndex));
        }
        const linkText = `@UUID[${match.uuid}]{${match.itemName}}`;
        linkedDescriptionBuilder.push(linkText);
        lastIndexProcessed = match.endIndex;
    });
    if (lastIndexProcessed < cleanedDescription.length) {
        linkedDescriptionBuilder.push(cleanedDescription.substring(lastIndexProcessed));
    }
    if (linkedDescriptionBuilder.length > 0) {
        overallResult.modifiedDescriptionWithActionLink = linkedDescriptionBuilder.join('');
        // console.log(`AI Identify: Final Linked Description: "${overallResult.modifiedDescriptionWithActionLink}"`); // DEBUG
    } else {
        overallResult.modifiedDescriptionWithActionLink = cleanedDescription; // Fallback
    }

    // --- 5. Identify Primary Action (from confirmed, likely the first one due to sort) ---
    let primaryActionInfo = confirmedMatches.find(m => m.startIndex === 0); // Prefer the one at the start
    if (!primaryActionInfo && confirmedMatches.length > 0) {
        primaryActionInfo = confirmedMatches[0]; // Fallback to first confirmed if none start at 0
    }

    // --- 6. Populate Result Object from Primary Action ---
    if (primaryActionInfo) {
        // console.log(`AI Identify: Setting primary action based on: "${primaryActionInfo.itemName}"`); // DEBUG
        const fullPrimaryItem = await fromUuid(primaryActionInfo.uuid) ?? actor.items.get(primaryActionInfo.itemId);

        if (fullPrimaryItem) {
            // Get cost from the identified primary item
            overallResult.actualActionCost = parseActionCostValue(fullPrimaryItem.system.time?.value, fullPrimaryItem.system.actions?.value, fullPrimaryItem.system.description?.value, fullPrimaryItem.system.actionType?.value);
            if (primaryActionInfo.itemType === 'strike') { // Strikes always cost 1 action
                overallResult.actualActionCost = 1;
            } else if (primaryActionInfo.itemType === 'consumable' && overallResult.actualActionCost === null) {
                overallResult.actualActionCost = 1; // Default consumable cost
            }
            if (overallResult.actualActionCost !== null) overallResult.costSource = "Action/Feat/Spell Item";
            overallResult.traits = fullPrimaryItem.system.traits?.value || [];

            // Populate type-specific fields
            switch (primaryActionInfo.itemType) {
                case 'spell':
                    overallResult.isSpellSuggestion = true;
                    overallResult.spellNameForButton = primaryActionInfo.itemName;
                    overallResult.spellImageUrl = primaryActionInfo.itemImg;
                    overallResult.spellLinkUUID = primaryActionInfo.uuid;
                    // --- ADDED: Parse Rank from Description ---
                    let parsedRankFromDesc = null;
                    const rankMatch = cleanedDescription.match(/\(Rank (\d+)\)/i);
                    if (rankMatch?.[1]) {
                        parsedRankFromDesc = parseInt(rankMatch[1], 10);
                        // console.log(`AI Identify: Parsed Rank ${parsedRankFromDesc} from description for spell "${primaryActionInfo.itemName}".`); // DEBUG
                    }
                    overallResult.spellRankForButton = parsedRankFromDesc; // Add parsed rank to result
                    // --- END ADDED ---
                    // Entry ID comes from the match data if available
                    overallResult.entryIdForButton = primaryActionInfo.entryId;
                    overallResult.spellIdForButton = primaryActionInfo.itemId; // Use item ID
                    overallResult.spellIsItem = !primaryActionInfo.entryId; // If no entry ID, assume item spell
                    break;
                case 'strike':
                    overallResult.isStrikeSuggestion = true;
                    overallResult.strikeIdentifierForButton = primaryActionInfo.strikeIdentifier; // Use stored identifier
                    overallResult.strikeNameForButton = primaryActionInfo.itemName;
                    overallResult.strikeImageUrl = primaryActionInfo.itemImg;
                    overallResult.strikeLinkUUID = primaryActionInfo.uuid; // UUID of the weapon/item
                    if (!overallResult.traits.includes('attack')) { overallResult.traits.push('attack'); }
                    break;
                case 'action': // Covers Action, Feat, Melee
                    overallResult.isGenericActionSuggestion = true;
                    overallResult.actionUUIDForLink = primaryActionInfo.uuid;
                    overallResult.actionNameForLink = primaryActionInfo.itemName;
                    overallResult.actionImageUrl = primaryActionInfo.itemImg;
                    overallResult.includesStrike = /\b(?:make|perform|attempt)s? (?:a|an|one|your) Strike\b/i.test(summarizeAbilityDetails(fullPrimaryItem.system.description?.value) || "");
                    if (overallResult.includesStrike && !overallResult.traits.includes('attack')) { overallResult.traits.push('attack'); }
                    if (fullPrimaryItem.system?.traits?.value?.includes('stance')) {
                        const selfEffectUuid = fullPrimaryItem.system.selfEffect?.uuid;
                        if (selfEffectUuid && selfEffectUuid.startsWith("Compendium.")) { overallResult.stanceEffectUUID = selfEffectUuid; }
                    }
                    break;
                case 'consumable':
                    overallResult.isConsumableSuggestion = true;
                    overallResult.consumableNameForButton = primaryActionInfo.itemName;
                    overallResult.consumableImageUrl = primaryActionInfo.itemImg;
                    overallResult.consumableItemUUID = primaryActionInfo.uuid;
                    if (overallResult.actualActionCost === null) overallResult.actualActionCost = 1; // Re-check default
                    if (overallResult.actualActionCost !== null) overallResult.costSource = "Consumable Item";
                    break;
            }
            // console.log(`AI Identify: Primary action details set (Cost: ${overallResult.actualActionCost}, Source: ${overallResult.costSource}, Type: ${primaryActionInfo.itemType})`); // DEBUG
        } else {
            // console.warn(`AI Identify: Could not retrieve full item data for primary action: "${primaryActionInfo.itemName}" (UUID: ${primaryActionInfo.uuid})`); // DEBUG
            overallResult.costSource = "LLM"; // Revert to LLM if item lookup failed
        }
    } else {
        // console.log(`AI Identify: No primary action identified. Cost source remains LLM.`); // DEBUG
        overallResult.costSource = "LLM";
        // Attempt to add basic traits if no item found but looks like an attack
        if (descriptionLower.includes('strike') || descriptionLower.includes('attack')) {
            if (!overallResult.traits.includes('attack')) overallResult.traits.push('attack');
        }
    }

    // Determine if it was a combo based on presence of '+' or 'then' in the *original* cleaned description
    // Ensure Flurry of Blows itself isn't marked as a combo unless explicitly combined with something else
    const originalPartsRegex = /\s*\+\s*|\s*,\s*then\s*|\s+then\s+/i;
    const isFlurry = primaryActionNameLower === 'flurry of blows';
    overallResult.isCombo = !isFlurry && originalPartsRegex.test(cleanedDescription) && confirmedMatches.length > 1; // Needs multiple confirmed matches to be a combo
    return overallResult;
}


// --- Settings Registration & Helpers ---

function registerSettings() {
    // Check if settings are already registered to avoid duplicates
    if (game.settings.settings.has(`${MODULE_ID}.apiKey`)) {
        // console.log("PF2e AI Combat Assistant | Settings already registered."); // DEBUG
        return;
    }
    // console.log("PF2e AI Combat Assistant | Registering settings..."); // DEBUG
    console.log("PF2e AI Combat Assistant | Registering module settings...");
    game.settings.register(MODULE_ID, 'apiKey', { name: 'LLM API Key', hint: 'Required API key for the LLM service (e.g., OpenAI). Keep this secret!', scope: 'world', config: true, type: String, default: '' });
    game.settings.register(MODULE_ID, 'llmEndpoint', { name: 'LLM API Endpoint URL', hint: 'URL for the chat completion API (e.g., OpenAI, local endpoint).', scope: 'world', config: true, type: String, default: 'https://api.openai.com/v1/chat/completions' });
    game.settings.register(MODULE_ID, 'aiModel', { name: 'LLM Model Name', hint: 'The specific model identifier to use (e.g., gpt-4o, gpt-3.5-turbo, local model ID).', scope: 'world', config: true, type: String, default: 'gpt-4o' });
    game.settings.register(MODULE_ID, 'showOfferToPlayers', { name: 'Show AI Offer/Suggestions to Players?', hint: 'If checked, players who own the current actor (or all players if no owner) will see the AI turn offer and suggestion messages. If unchecked, only the GM sees these messages.', scope: 'world', config: true, type: Boolean, default: false });
    game.settings.register(MODULE_ID, 'includeReactionsInPrompt', { name: "Include Reactions in Prompt", hint: "Include Reaction abilities in the list sent to the AI for consideration.", scope: "world", config: true, type: Boolean, default: true });
    game.settings.register(MODULE_ID, 'deleteDesignationMessageOnConfirm', { name: "Delete Designation Message on Confirm?", hint: "If checked, the 'AI Designation Setup' chat message will be automatically deleted after you click 'Confirm Designations'.", scope: 'world', config: true, type: Boolean, default: false });

    // Setting: Whisper Turn Summary to GM Only
    game.settings.register(MODULE_ID, 'whisperTurnSummary', {
        name: game.i18n.localize(`${MODULE_ID}.settings.whisperTurnSummary.name`),
        hint: game.i18n.localize(`${MODULE_ID}.settings.whisperTurnSummary.hint`),
        scope: 'world', // GM controls this setting
        config: true,   // Show in module settings
        type: Boolean,
        default: false, // Default to public messages
        requiresReload: false // No reload needed
    });
}

// --- Hooks ---

// Hook to store the timestamp when a combatant's turn starts
Hooks.on("updateCombat", (combat, changed, options, userId) => {
    // Check if the turn has changed and we have a valid turn number
    if (changed.hasOwnProperty('turn') && typeof changed.turn === 'number') {
        // console.log(`AI Debug Hook: Turn changed to ${changed.turn}. Setting turnStartTime flag.`); // DEBUG
        combat.setFlag(MODULE_ID, 'turnStartTime', Date.now());
    }
});

// Helper to determine whisper recipients based on setting
function getWhisperRecipientsOffer() { return game.settings.get(MODULE_ID, 'showOfferToPlayers') ? [] : ChatMessage.getWhisperRecipients("GM"); }
// Helper to determine whisper recipients based on setting
function getWhisperRecipientsSuggestions() { return game.settings.get(MODULE_ID, 'showOfferToPlayers') ? [] : ChatMessage.getWhisperRecipients("GM"); }
// --- Chat Message Hook for Interim Results ---

/**
 * Stores the ID of the last chat message representing a confirmed AI action.
 * Keyed by combatant ID.
 * @type {Map<string, string>}
 */
const lastConfirmedActionMessageIds = new Map(); // TODO: Integrate usage

/**
 * Handles newly created chat messages to potentially extract interim results
 * between AI actions.
 * @param {ChatMessagePF2e} message - The chat message document.
 * @param {object} options - Additional options provided by the hook.
 * @param {string} userId - The ID of the user who created the message.
 */
async function handleChatMessage(message, options, userId) {
    // Ignore messages created by the current user if they are the GM controlling the AI
    // (prevents processing the AI's own suggestion/action messages as feedback)
    // Or, more simply, ignore messages we flag as temporary thinking messages
     if (message.getFlag(MODULE_ID, FLAGS.TEMP_THINKING)) {
         // Let's also delete the "Thinking..." message now that a real message followed it
         // Check if the message still exists before trying to delete
         const thinkingMessage = game.messages.get(message.id);
         if (thinkingMessage) {
             try {
                // await thinkingMessage.delete(); // Temporarily disable auto-delete, might be annoying
             } catch (err) {
                 console.warn(`PF2e AI Combat Assistant | Failed to delete thinking message ${message.id}:`, err);
             }
         }
         return;
     }

    // Ensure we are in combat and the message isn't private or a whisper to others
    if (!game.combat?.started || !game.combat.combatant || (message.whisper.length > 0 && !message.isContentVisible)) {
        return;
    }

    const combatant = game.combat.combatant;
    const actor = combatant.actor;
    if (!actor) return; // Actor might not be loaded yet

    // Check if the current combatant is AI controlled
    // TODO: Refine this logic. We only want to capture messages *after* a confirmed action
    // and *before* the next suggestion is requested. This requires tracking the state more precisely.
    const isAiControlled = actor.getFlag(MODULE_ID, FLAGS.DESIGNATIONS) === 'ai'; // Assuming 'ai' is a possible designation

    // Only process if the current turn *is* the AI's turn, even if not actively processing (e.g., waiting for user input on reaction)
    // AND check if the message occurred *after* the last confirmed action for this combatant
    const lastActionMsgId = lastConfirmedActionMessageIds.get(combatant.id);
    const isAfterLastAction = !lastActionMsgId || message.id > lastActionMsgId; // Simple ID comparison assumes IDs are sequential

    if (isAiControlled && game.combat.current.combatantId === combatant.id && isAfterLastAction) {
        // console.log(`PF2e AI Combat Assistant | Chat Message Hook: AI Combatant ${combatant.name}'s turn. Relevant message received:`, message); // DEBUG
        console.log("PF2e AI Combat Assistant | Processing message object for recentEvents:", message); // DEBUG: Log the full message object

        // --- Placeholder for Parsing Logic ---
        let parsedResult = null;
        const context = message.flags?.pf2e?.context;
        const speakerActor = ChatMessage.getSpeakerActor(message.speaker); // Actor who generated the message
        const speakerToken = ChatMessage.getSpeakerToken(message.speaker); // Token who generated the message

        // --- Parsing logic based on message context ---
        if (context) {
            const targetActor = fromUuidSync(context.target?.actor ?? ''); // Use fromUuidSync
            const targetTokenName = context.target?.token?.name ?? context.target?.actor?.name ?? 'Unknown Target';
            const outcome = context.outcome ? context.outcome.toUpperCase() : 'UNKNOWN';
            const actionName = context.options?.find(o => o.startsWith('action:'))?.split(':')[1] || context.item?.name || context.type || 'Action'; // Try to get action name

            // --- Message relates to the AI actor's action ---
            if (speakerActor?.id === actor.id || speakerToken?.id === combatant.token?.id) {
                if (context.type === 'attack-roll' || context.type === 'spell-attack-roll') {
                    parsedResult = `Attack Roll (${actionName}): ${outcome} vs ${targetTokenName}.`; // Keep this for interim results
                    // console.log(`PF2e AI Combat Assistant | Parsed (AI Action): ${parsedResult}`); // DEBUG

                    // --- ADDED: Record Successful Strikes for Prerequisite Checks ---
                    if (outcome === 'SUCCESS' || outcome === 'CRITICAL SUCCESS') {
                        // Ensure this message corresponds to the *current* AI combatant's turn
                        if (game.combat?.combatant?.actorId === speakerActor?.id) {
                            const currentTurnState = speakerActor.getFlag(MODULE_ID, FLAGS.TURN_STATE);
                            if (currentTurnState) {
                                // Initialize array if it doesn't exist
                                if (!Array.isArray(currentTurnState.successfulStrikesThisRound)) {
                                    currentTurnState.successfulStrikesThisRound = [];
                                }
                                // Add the successful strike info
                                currentTurnState.successfulStrikesThisRound.push({
                                    targetName: targetTokenName, // Use the parsed target name
                                    strikeName: actionName      // Use the parsed action name
                                });
                                // Update the flag (no await needed for setFlag typically, but can add if issues arise)
                                await speakerActor.setFlag(MODULE_ID, FLAGS.TURN_STATE, currentTurnState);
                                // console.log(`AI Record Strike: Recorded successful '${actionName}' vs '${targetTokenName}' for ${speakerActor.name}. New count: ${currentTurnState.successfulStrikesThisRound.length}`); // DEBUG
                            }
                        }
                    }
                    // --- END ADDED ---
                }
                     // console.log(`PF2e AI Combat Assistant | Parsed (AI Action): ${parsedResult}`); // DEBUG (Corrected indentation)
                 else if (context.type === 'damage-roll') { // Removed extra '}'
                    const totalDamage = message.rolls?.reduce((sum, roll) => sum + roll.total, 0) || 0;
                    if (totalDamage > 0) {
                        parsedResult = `Damage Roll (${actionName}): ${totalDamage} damage to ${targetTokenName}.`;
                        // console.log(`PF2e AI Combat Assistant | Parsed (AI Action): ${parsedResult}`); // DEBUG
                    }
                } else if (context.type === 'saving-throw') {
                    // This case is usually when the AI *forces* a save
                    const saveType = context.statistic || 'Unknown Save';
                    parsedResult = `Forced Save (${actionName}): ${targetTokenName} rolled ${outcome} on ${saveType} save.`;
                    // console.log(`PF2e AI Combat Assistant | Parsed (AI Action): ${parsedResult}`); // DEBUG
                } else if (context.type === 'skill-check') {
                    const skill = context.statistic || 'Unknown Skill';
                    parsedResult = `Skill Check (${actionName} - ${skill}): ${outcome}.`;
                    // console.log(`PF2e AI Combat Assistant | Parsed (AI Action): ${parsedResult}`); // DEBUG
                }
                // TODO: Add parsing for condition application/removal initiated by AI?
            }
            // --- Message relates to something targeting the AI actor ---
            else if (targetActor?.id === actor.id || context.target?.token?.id === combatant.token?.id) {
                 const sourceName = speakerToken?.name || speakerActor?.name || 'Unknown Source';
                 if (context.type === 'attack-roll' || context.type === 'spell-attack-roll') {
                     parsedResult = `Attack Roll vs AI (${actionName} from ${sourceName}): ${outcome}.`;
                     // console.log(`PF2e AI Combat Assistant | Parsed (Targeting AI): ${parsedResult}`); // DEBUG
                 } else if (context.type === 'damage-roll') {
                     const totalDamage = message.rolls?.reduce((sum, roll) => sum + roll.total, 0) || 0;
                     if (totalDamage > 0) {
                         parsedResult = `Damage Roll vs AI (${actionName} from ${sourceName}): ${totalDamage} damage taken.`;
                         // console.log(`PF2e AI Combat Assistant | Parsed (Targeting AI): ${parsedResult}`); // DEBUG
                     }
                 } else if (context.type === 'saving-throw') {
                     const saveType = context.statistic || 'Unknown Save';
                     parsedResult = `Saving Throw by AI (${saveType} vs ${actionName} from ${sourceName}): ${outcome}.`;
                     // console.log(`PF2e AI Combat Assistant | Parsed (Targeting AI): ${parsedResult}`); // DEBUG
                 }
                 // TODO: Add parsing for skill checks targeting AI, condition application?
            }
            // --- Message relates to other actors (e.g., ally action, enemy action vs ally) ---
            // This might be useful context too, but let's keep it focused for now.
            // else { console.log(`PF2e AI Combat Assistant | Message context not directly involving AI actor or its target. Speaker: ${speakerActor?.name}, Target: ${targetTokenName}`); }

        } else if (message.content?.includes('Reaction')) {
            // Basic check for reactions mentioned in text (less reliable)
            const sourceName = speakerToken?.name || speakerActor?.name || message.speaker?.alias || 'Unknown Source';
            if (sourceName !== actor.name) { // Don't log the AI's own reaction use if it announced it
                 parsedResult = `Other Action: ${sourceName} used a Reaction (details unknown).`;
                 // console.log(`PF2e AI Combat Assistant | Parsed (Other): ${parsedResult}`); // DEBUG
            }
        }
        // TODO: Add more robust parsing for non-context messages if needed


        // --- Interim Results logic removed ---
        // if (parsedResult) {
        //     // Storing logic was here...
        // }
    }
}


// --- Module Initialization ---

Hooks.once('ready', () => {
    console.log("PF2e AI Combat Assistant | Ready Hook: Initializing.");

    // Register Settings if not already done (safe check inside function)
    registerSettings();
    // Hook to add AI Notes field to PC sheet biography tab
    Hooks.on('renderActorSheetPF2eCharacter', (sheet, html, data) => {
        console.log("PF2e AI Combat Assistant | renderActorSheetPF2eCharacter hook fired for:", sheet.actor.name); // DEBUG LOG 1

        // sheet: The ActorSheet instance
        // html: jQuery object representing the sheet's HTML content
        // data: The data object used to render the sheet (contains actor data)

        // 1. Define your module ID and flag key
        const MODULE_ID = 'pf2e-ai-combat-assistant'; // Make sure this matches your constant
        const FLAG_KEY = FLAGS.PERMANENT_NOTES; // Use the constant

        // 2. Find the Biography tab content area
        //    The exact selector might vary slightly with Foundry/PF2e updates,
        //    but it's usually a div with class 'tab' and data-tab='biography'
        const biographyTab = html.find('.tab[data-tab="biography"]');
        console.log("PF2e AI Combat Assistant | Found biographyTab element:", biographyTab); // DEBUG LOG 2

        if (biographyTab.length > 0) {
            console.log("PF2e AI Combat Assistant | Biography tab found. Proceeding to add AI Notes field."); // DEBUG LOG 3
            // 3. Get the current notes from the actor's flags
            const actor = sheet.actor;
            const currentNotes = actor.getFlag(MODULE_ID, FLAG_KEY) || ''; // Default to empty string if no flag exists

            // 4. Create the HTML for the new section
            //    Using Foundry's form-group structure for consistency
            const notesSectionHTML = `
                <fieldset class="form-group form-group-stacked">
                    <legend>AI Notes</legend>
                    <textarea name="flags.${MODULE_ID}.${FLAG_KEY}" placeholder="Enter permanent notes for the AI here...">${currentNotes}</textarea>
                </fieldset>
            `;

            // 5. Append the new section to the bottom of the biography tab
            biographyTab.append(notesSectionHTML);

            // --- Simple Textarea Saving ---
            // 6. Add an event listener to save changes when the textarea loses focus (blur)
            const notesTextarea = biographyTab.find(`textarea[name="flags.${MODULE_ID}.${FLAG_KEY}"]`);
            notesTextarea.on('blur', async (event) => {
                const newNotes = event.target.value;
                try {
                    await actor.setFlag(MODULE_ID, FLAG_KEY, newNotes);
                    console.log(`PF2e AI Combat Assistant | Saved AI Notes for ${actor.name}`);
                } catch (err) {
                    console.error(`PF2e AI Combat Assistant | Error saving AI Notes flag:`, err);
                }
            });

            // --- Optional: Adjust sheet height if needed ---
            // Sometimes adding content requires telling the sheet to recalculate its position/height
            // sheet.setPosition(); // Uncomment if the sheet layout seems off after adding the field
        } else {
            console.warn(`PF2e AI Combat Assistant | Could not find biography tab (.tab[data-tab="biography"]) in CharacterSheetPF2e to add AI Notes.`); // DEBUG LOG 4 (modified)
        }
    });
// Function to open the AI Notes editing dialog
async function openAINotesDialog(actor) {
    const MODULE_ID = 'pf2e-ai-combat-assistant'; // Ensure consistency
    const FLAG_KEY = FLAGS.PERMANENT_NOTES;
    const currentNotes = actor.getFlag(MODULE_ID, FLAG_KEY) || '';

    const content = `
        <form>
            <div class="form-group">
                <label>Permanent AI Notes:</label>
                <textarea name="aiNotes" style="width: 98%; min-height: 150px;" placeholder="Enter notes for the AI...">${currentNotes}</textarea>
            </div>
        </form>
    `;

    new Dialog({
        title: `AI Notes for ${actor.name}`,
        content: content,
        buttons: {
            save: {
                icon: '<i class="fas fa-save"></i>',
                label: "Save",
                callback: async (html) => {
                    const newNotes = html.find('textarea[name="aiNotes"]').val();
                    try {
                        await actor.setFlag(MODULE_ID, FLAG_KEY, newNotes);
                        console.log(`PF2e AI Combat Assistant | Saved AI Notes for ${actor.name} via dialog.`);
                        ui.notifications.info(`AI Notes saved for ${actor.name}.`);
                    } catch (err) {
                        console.error(`PF2e AI Combat Assistant | Error saving AI Notes flag via dialog:`, err);
                        ui.notifications.error(`Error saving AI Notes for ${actor.name}.`);
                    }
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: "Cancel"
            }
        },
        default: "save"
    }).render(true);
}

    // Hook into chat message creation
    Hooks.on('createChatMessage', handleChatMessage);

    // Hook to add header button to PC sheets
    // Hook to add header button to PC sheets
    Hooks.on('getActorSheetHeaderButtons', (sheet, buttons) => {
        // Only add the button to Player Character sheets
        if (!(sheet.actor.type === 'character')) {
             return;
        }

        buttons.unshift({ // Add to the beginning of the button list
            label: "AI Notes",
            class: "configure-ai-notes",
            icon: "fas fa-brain", // Example icon
            onclick: (ev) => {
                openAINotesDialog(sheet.actor);
            }
        });
        console.log(`PF2e AI Combat Assistant | Added AI Notes button to header for ${sheet.actor.name}`); // DEBUG
    });

    // Add button listeners to chat messages (assuming this setup happens elsewhere)
    // Example: Hooks.on('renderChatMessage', addActionButtons);

    console.log("PF2e AI Combat Assistant | Initialization Complete.");
});



// Final log message update
console.log("PF2e AI Combat Assistant | Module Loaded Successfully (v1.0)");