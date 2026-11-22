// One shelf per kind of problem; each shelf is its own kind of physical media.
// The wall shows them top to bottom in this order.
export const SHELVES = {
  'make-it-do-more': { name: 'Make it do more', line: "It wasn't built to do that.", media: 'cartridge', extras: 'Instruction manual', proof: 'Screenshots', sticker: 'BLOW ON IT FIRST', code: 'MDM', color: '#3d7bd9' },
  'bring-it-back': { name: 'Bring it back', line: "It died. I didn't let it.", media: 'vhs', extras: 'Behind the scenes', proof: 'Caught on tape', sticker: 'BE KIND, REWIND', code: 'BIB', color: '#d8432f' },
  'keep-it-running': { name: 'Keep it running', line: 'It runs while I sleep.', media: '8track', extras: 'Service log', proof: 'On the meters', sticker: 'PLAYS FOREVER', code: 'KIR', color: '#e3a92b' },
  'missing-tool': { name: 'Build the missing tool', line: 'Nothing did this, so I made it.', media: 'floppy', extras: 'Print the README', proof: 'Printed out', sticker: 'SHAREWARE: PASS IT ON', code: 'BMT', color: '#4f9e6b' },
  'for-my-people': { name: 'For my people', line: 'Someone I know needed it.', media: 'cassette', extras: 'Unfold the J-card', proof: 'Snapshots', sticker: 'PLAY IT LOUD', code: 'FMP', color: '#c3559a' },
  'original-works': { name: 'Original works', line: 'Blank page.', media: 'vinyl', extras: 'Slide the record out', proof: 'Photos', sticker: '33 1/3 RPM', code: 'ORW', color: '#8a62d1' },
  'on-the-clock': { name: 'On the clock', line: "Things I do when I'm on the clock.", media: 'pcbox', extras: 'Getting started manual', proof: 'On screen', sticker: 'PUNCH IN FIRST', code: 'OTC', color: '#3a8fb7' },
  'how-things-ship': { name: 'How things ship', line: 'From an AI chat to the live product, without breaking it.', media: 'filmcan', extras: 'Run the film', proof: 'On the reel', sticker: 'KEEP IT ROLLING', code: 'HTS', color: '#d9893a' },
  'ai-workstation': { name: 'The AI workstation', line: 'Twenty AI chats, one desk.', media: 'laserdisc', extras: 'Open the gatefold', proof: 'On the record', sticker: 'SPECIAL EDITION', code: 'AIW', color: '#e0b04a' },
}
