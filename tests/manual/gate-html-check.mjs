// Manual verification (PRD-040): boot the real memo-view server against a temp memo dir,
// fetch the emitted HTML page, run a syntax/tag-balance check, and verify the WebSocket
// content message carries the `validation` field. Run with:
//   BROWSER=true node tests/manual/gate-html-check.mjs
// (BROWSER=true makes the spawned `open` a no-op on macOS via the env override below.)
import { WebSocket } from 'ws'

import { MemoView } from '../../src/MemoView.mjs'


const PORT = 4444
const DIR = '/tmp/memo-gate-check/revs'


const countTag = ( html, tag ) => {
    const open = ( html.match( new RegExp( `<${ tag }(\\s|>)`, 'gi' ) ) || [] ).length
    const close = ( html.match( new RegExp( `</${ tag }>`, 'gi' ) ) || [] ).length

    return { open, close }
}


const main = async () => {
    await MemoView.startDirectory( { dirPath: DIR, port: PORT } )

    // 1) Emitted-HTML syntax check.
    const res = await fetch( `http://localhost:${ PORT }/` )
    const html = await res.text()
    const doctypeOk = /^<!DOCTYPE html>/i.test( html.trim() )
    const htmlBal = countTag( html, 'html' )
    const headBal = countTag( html, 'head' )
    const bodyBal = countTag( html, 'body' )
    const scriptBal = countTag( html, 'script' )

    const htmlOk = doctypeOk
        && htmlBal.open === 1 && htmlBal.close === 1
        && headBal.open === 1 && headBal.close === 1
        && bodyBal.open === 1 && bodyBal.close === 1
        && scriptBal.open === scriptBal.close

    process.stdout.write( `HTML doctype: ${ doctypeOk }, html ${ JSON.stringify( htmlBal ) }, head ${ JSON.stringify( headBal ) }, body ${ JSON.stringify( bodyBal ) }, script ${ JSON.stringify( scriptBal ) }\n` )
    process.stdout.write( `HTML syntax OK: ${ htmlOk }\n` )

    // 2) WebSocket content message carries validation.
    const ws = new WebSocket( `ws://localhost:${ PORT }/` )
    const validationField = await new Promise( ( resolvePromise ) => {
        const timer = setTimeout( () => resolvePromise( undefined ), 4000 )
        ws.on( 'message', ( raw ) => {
            const msg = JSON.parse( raw.toString() )

            if( msg.type === 'content' ) {
                clearTimeout( timer )
                resolvePromise( msg.validation )
            }
        } )
    } )

    const hasValidation = validationField !== undefined && validationField !== null
        && typeof validationField.status === 'boolean'
        && Array.isArray( validationField.messages )
        && Array.isArray( validationField.info )

    process.stdout.write( `content.validation present + shape OK: ${ hasValidation }\n` )
    process.stdout.write( `validation.status: ${ validationField && validationField.status }\n` )

    ws.close()

    const allOk = htmlOk && hasValidation

    process.stdout.write( `RESULT: ${ allOk ? 'PASS' : 'FAIL' }\n` )
    process.exit( allOk ? 0 : 1 )
}


main()
