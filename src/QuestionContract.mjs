// Memo 041 Teil B (Kap 10): the ONE render contract — the single source of truth for the rule
// "is this question renderable as an interactive card?". Before Memo 041 this rule lived ONLY in
// the browser (isQuestionCleanParse, src/public/app.client.mjs) while the server-side MemoValidator
// checked a DIFFERENT set and never inspected option.kind — so a payload could pass every validator
// and still fall back to raw text in the browser (the split-brain). This module makes the rule a
// shared, importable definition:
//   - MemoValidator imports VALID_OPTION_KINDS for the MEMO-033 kind-validity check (the exact gap),
//     and DocumentRegistry imports it to coerce unknown kinds defensively (belt + suspenders).
//   - The browser client script is INLINED into the page (it is not an importable ES module), so it
//     carries a hand-kept MIRROR of isRenderable() as isQuestionCleanParse(). The parity between the
//     two is enforced by tests/unit/QuestionContract.test.mjs, so they can never drift again.
// Pure, dependency-free, never throws.


// The only option.kind values the renderer understands. `option` is an author-supplied answer
// choice; `custom`/`topic` are the two defaults the parser injects (ablehnen / Über das Topic
// springen). Anything else is a defect — it makes the option vanish from the card (MEMO-033).
const VALID_OPTION_KINDS = [ 'option', 'custom', 'topic' ]


// EXACT logic mirror of isQuestionCleanParse (src/public/app.client.mjs). Returns true only when
// the question can be rendered as a clean interactive card: a well-formed F-id, a non-empty Frage,
// at least two distinct real options (kind === 'option'), and — for single-select — an AI
// recommendation that references exactly one existing option key. Keep this in lock-step with the
// client mirror (the drift test asserts identical verdicts on a fixture corpus).
const isRenderable = ( { question } ) => {
    const q = question

    if( !q || typeof q !== 'object' ) { return false }

    const id = typeof q[ 'id' ] === 'string' ? q[ 'id' ].trim() : ''
    if( !/^F\d+$/.test( id ) ) { return false }

    const frage = typeof q[ 'frage' ] === 'string' ? q[ 'frage' ].trim() : ''
    if( frage.length === 0 ) { return false }

    const aiRecommendation = typeof q[ 'aiRecommendation' ] === 'string' ? q[ 'aiRecommendation' ].trim() : ''
    const isMulti = q[ 'typ' ] === 'multi'
    if( !isMulti && aiRecommendation.length === 0 ) { return false }

    const realOptions = ( Array.isArray( q[ 'options' ] ) ? q[ 'options' ] : [] )
        .filter( ( o ) => o && typeof o === 'object' && o[ 'kind' ] === 'option' )
        .filter( ( o ) => {
            return typeof o[ 'key' ] === 'string' && o[ 'key' ].trim().length > 0
                && typeof o[ 'label' ] === 'string' && o[ 'label' ].trim().length > 0
        } )

    const optionKeys = realOptions.map( ( o ) => o[ 'key' ].trim() )
    const distinctKeys = optionKeys.filter( ( key, idx ) => optionKeys.indexOf( key ) === idx )
    if( distinctKeys.length < 2 ) { return false }

    if( !isMulti ) {
        const recommendedKeys = ( aiRecommendation.toUpperCase().match( /\b([A-H])\b/g ) || [] )
        const referencesExisting = recommendedKeys.some( ( key ) => distinctKeys.indexOf( key ) !== -1 )
        if( !referencesExisting ) { return false }

        const distinctRec = recommendedKeys.filter( ( key, idx ) => recommendedKeys.indexOf( key ) === idx )
        const existingRec = distinctRec.filter( ( key ) => distinctKeys.indexOf( key ) !== -1 )
        if( existingRec.length !== 1 ) { return false }
    }

    return true
}


// Given the RAW (un-normalised) option list of a question, return the options whose `kind` is a
// PRESENT string that is not one of VALID_OPTION_KINDS. A missing `kind` is NOT a defect (it
// defaults to 'option'); only an explicit, invalid value is. Drives MEMO-033.
const invalidOptionKinds = ( { options } ) => {
    const list = Array.isArray( options ) ? options : []

    return list
        .filter( ( o ) => o !== null && typeof o === 'object' )
        .filter( ( o ) => typeof o[ 'kind' ] === 'string' && !VALID_OPTION_KINDS.includes( o[ 'kind' ] ) )
        .map( ( o ) => {
            return {
                'key': typeof o[ 'key' ] === 'string' ? o[ 'key' ] : '',
                'kind': o[ 'kind' ]
            }
        } )
}


export { VALID_OPTION_KINDS, isRenderable, invalidOptionKinds }
