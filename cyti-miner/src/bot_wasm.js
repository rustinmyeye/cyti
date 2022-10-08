import JSONBigInt from 'json-bigint';
import { CYTI_MINT_REQUEST_SCRIPT_ADDRESS, MIN_NANOERG_BOX_VALUE, TX_FEE } from './constants.js';
import { currentHeight, sendTx } from './explorer.js';
import { createTransaction, decodeStringArray, encodeHexConst, encodeStrConst, getRegisterValue, signTransaction } from './wasm.js';
import workerpool from 'workerpool';
import { config } from '../config.js';
let ergolib = import('ergo-lib-wasm-nodejs');


export async function processMintRequestParallel(mintRequestJSON, setCurrentHashRate) {
    const creationHeight = await currentHeight();
    const mintRequestWASM = (await ergolib).ErgoBox.from_json(JSONBigInt.stringify(mintRequestJSON))
    const mintRequestValueNano = mintRequestJSON.value - TX_FEE;
    const mintRequestBoxValue = (await ergolib).BoxValue.from_i64((await ergolib).I64.from_str(mintRequestValueNano.toString()));
    const outputCandidates = (await ergolib).ErgoBoxCandidates.empty();
    const mintRequestBoxBuilder = new (await ergolib).ErgoBoxCandidateBuilder(
        mintRequestBoxValue,
        (await ergolib).Contract.pay_to_address((await ergolib).Address.from_base58(CYTI_MINT_REQUEST_SCRIPT_ADDRESS)),
        creationHeight);
    mintRequestBoxBuilder.set_register_value(4, mintRequestWASM.register_value(4))
    mintRequestBoxBuilder.set_register_value(5, mintRequestWASM.register_value(5))
    mintRequestBoxBuilder.set_register_value(6, mintRequestWASM.register_value(6))
    mintRequestBoxBuilder.set_register_value(7, mintRequestWASM.register_value(7))
    const minerSigmaProp = (await ergolib).Constant.from_ecpoint_bytes(
        (await ergolib).Address.from_base58(config.MINER_ADDRESS).to_bytes(0x00).subarray(1, 34)
    );
    mintRequestBoxBuilder.set_register_value(8, minerSigmaProp);
    mintRequestBoxBuilder.set_register_value(9, await encodeHexConst('00'));
    try {
        outputCandidates.add(mintRequestBoxBuilder.build());
    } catch (e) {
        console.log(`CYTI miner building error: ${e}`);
        throw e;
    }
    const inputsWASM = (await ergolib).ErgoBoxes.from_boxes_json([mintRequestJSON]);
    const dataListWASM = new (await ergolib).ErgoBoxAssetsDataList();
    const boxSelection = new (await ergolib).BoxSelection(inputsWASM, dataListWASM);
    const tx = await createTransaction(boxSelection, outputCandidates, [], config.MINER_ADDRESS, [mintRequestJSON]);
    //console.log("tx", tx);
    tx.outputs[0].additionalRegisters["R9"] = "#NONCE#";

    // create a worker pool using an external worker script
    const pool = workerpool.pool('./src/worker.js', { workerType: 'process' });

    // Launch parallel processing
    const promises = [];
    var workersHashRate = {};
    var totalHashRate = 0;
    for (let i = 0; i < config.PARALLEL_DEGREE; i++) {
        workersHashRate[i] = 0;
        promises.push(pool.exec('signWithNonce', [JSONBigInt.stringify(tx), mintRequestJSON, config.NUM_ITERATIONS.toString(), i.toString()],
            {
                on: function (payload) {
                    workersHashRate[payload.workerId] = payload.hashRate;
                    totalHashRate = Object.values(workersHashRate).reduce((a, b) => a + b);
                    setCurrentHashRate(totalHashRate);
                }
            }
        ).then(function (result) {
            return result;
        }))
    }

    // waits for the results
    try {
        const result = await Promise.any(promises);
        pool.terminate(true);
        return result;
    } catch (e) {
        // ignore, all failed
        pool.terminate(true);
        console.log(e)
        return false;
    }
}


export async function processMintResults(mintRequestJSON) {
    try {
        const wallet = (await ergolib).Wallet.from_mnemonic("", "");
        const creationHeight = await currentHeight();
        const mintRequestWASM = (await ergolib).ErgoBox.from_json(JSONBigInt.stringify(mintRequestJSON))
        const minerPaymentValueNano = mintRequestJSON.value - TX_FEE - MIN_NANOERG_BOX_VALUE;
        const minerPaymentBoxValue = (await ergolib).BoxValue.from_i64((await ergolib).I64.from_str(minerPaymentValueNano.toString()));
        const outputCandidates = (await ergolib).ErgoBoxCandidates.empty();
        // MINER FEE BOX
        const minerAddressScript = mintRequestWASM.register_value(8).encode_to_base16();
        const minerAddress = (await ergolib).Address.recreate_from_ergo_tree((await ergolib).ErgoTree.from_base16_bytes("00" + minerAddressScript)).to_base58();
        const minerPaymentBoxBuilder = new (await ergolib).ErgoBoxCandidateBuilder(
            minerPaymentBoxValue,
            (await ergolib).Contract.pay_to_address((await ergolib).Address.from_base58(minerAddress)),
            creationHeight);
        try {
            outputCandidates.add(minerPaymentBoxBuilder.build());
        } catch (e) {
            console.log(`processMintResults building error: ${e}`);
            throw e;
        }

        // MINT TOKEN BOX
        const minterAddressScript = mintRequestWASM.register_value(6).encode_to_base16();
        const minterAddress = (await ergolib).Address.recreate_from_ergo_tree((await ergolib).ErgoTree.from_base16_bytes("00" + minterAddressScript)).to_base58();
        const mintTokenBoxValue = (await ergolib).BoxValue.from_i64((await ergolib).I64.from_str(MIN_NANOERG_BOX_VALUE.toString()));
        const mintTokenBoxBuilder = new (await ergolib).ErgoBoxCandidateBuilder(
            mintTokenBoxValue,
            (await ergolib).Contract.pay_to_address((await ergolib).Address.from_base58(minterAddress)),
            creationHeight);
        const register5 = await decodeStringArray(getRegisterValue(mintRequestJSON, "R5"))
        mintTokenBoxBuilder.set_register_value(4, await encodeStrConst(register5[0]))
        mintTokenBoxBuilder.set_register_value(5, await encodeStrConst(register5[1]))
        mintTokenBoxBuilder.set_register_value(6, await encodeStrConst(register5[2]))
        mintTokenBoxBuilder.set_register_value(7, await encodeStrConst(register5[3]))
        mintTokenBoxBuilder.set_register_value(8, await encodeStrConst(register5[4]))
        mintTokenBoxBuilder.set_register_value(9, await encodeStrConst(register5[5]))
        const mintTokenAmount = (await ergolib).TokenAmount.from_i64(mintRequestWASM.register_value(4).to_i64());
        const tokenId = (await ergolib).TokenId.from_str(mintRequestJSON.boxId);
        mintTokenBoxBuilder.add_token(tokenId, mintTokenAmount);
        try {
            outputCandidates.add(mintTokenBoxBuilder.build());
        } catch (e) {
            console.log(`processMintResults building error: ${e}`);
            throw e;
        }
        const inputsWASM = (await ergolib).ErgoBoxes.from_boxes_json([mintRequestJSON]);
        const dataListWASM = new (await ergolib).ErgoBoxAssetsDataList();
        const boxSelection = new (await ergolib).BoxSelection(inputsWASM, dataListWASM);
        const tx = await createTransaction(boxSelection, outputCandidates, [], config.MINER_ADDRESS, [mintRequestJSON]);
        //console.log("processMintResults signedTx", JSONBigInt.stringify(tx));
        const signedTx = JSONBigInt.parse(await signTransaction(tx, [mintRequestJSON], [], wallet));
        const txId = await sendTx(signedTx);
        return txId;
    } catch (e) {
        console.log(e);
    }
}
