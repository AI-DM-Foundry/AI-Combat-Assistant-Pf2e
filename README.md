
# PF2e AI Combat Assistant for Foundry VTT

An AI-powered combat assistant module for Pathfinder 2e (PF2e) in Foundry Virtual Tabletop.  
This module analyzes the full game state and suggests the best possible action for any creature on their turn, taking into account:

- Enemies and allies
- Current conditions and active effects
- All available actions, spells, and items
- Tactical positioning, initiative, and status effects

## Features

- Smart tactical suggestions for both PCs and NPCs
- Deep rules-aware integration with PF2e mechanics
- Real-time analysis of combat state
- Supports context-sensitive actions, spells, items, reactions, and more
- Allows persistent per-character AI instructions
- Accepts temporary per-turn instructions to guide behavior

## Requirements

- Foundry VTT **v12+**
- Pathfinder 2e system installed

## Installation

1. Clone or download this repository.
2. Place the folder in your Foundry modules directory:
   ```
   C:\Users\<YourName>\AppData\Local\FoundryVTT\Data\modules\
   ```
3. Ensure the folder is named `pf2e-ai-combat-assistant`
4. Launch Foundry VTT, go to **Configuration > Manage Modules**
5. Enable **PF2e AI Combat Assistant** in your game world

## 📘 How to Use

### 0. Set Up the LLM Connection
![LLM setup screen](media/llm-setup.png)

### 1. Add All Creatures to Combat
![Add creatures to combat](media/add-to-combat.png)

### 2. Assign Friendly and Enemy Designations
![Assign Friend/Enemy](media/assign-designations.png)

### 3. Roll Initiatives and Begin the Encounter
![Begin Encounter](media/begin-encounter.png)

### 4. Choose to Use the AI Assistant
![Accept AI prompt](media/accept-ai.png)

### 5. Follow the Suggested Action
![AI action suggestion](media/action-suggestion.png)

### 6. Continue Acting Until the Turn Ends
![Next suggestion](media/next-suggestion.png)

### 7. Execute the Suggested Strike, Spell, or Item
![Linked strike example](media/linked-strike.png)

### 8. Review the Turn Summary
![Turn summary](media/turn-summary.png)

## 🧠 Why It Matters: Run Any Creature With Confidence
![Casting example](media/vision-of-death.png)  
![Narrative summary](media/dragon-turn-summary.png)

## ⚙️ Advanced Tips

### Adjust MAP Manually
![Adjust MAP manually](media/adjust-map.png)

### Use Manual Notes for Smarter Suggestions
![Manual note example](media/manual-note.png)

### Add Permanent Notes to Player Characters
![Permanent AI notes](media/permanent-notes.png)
