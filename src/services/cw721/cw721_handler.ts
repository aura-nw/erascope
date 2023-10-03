import { Dictionary } from 'lodash';
import CW721Token from '../../models/cw721_token';
import CW721Activity from '../../models/cw721_tx';
import { SmartContractEvent } from '../../models/smart_contract_event';
import { getAttributeFrom } from '../../common/utils/smart_contract';
import { EventAttribute } from '../../models';
import CW721Contract from '../../models/cw721_contract';

export class Cw721Handler {
  tokensKeyBy: Dictionary<CW721Token>;

  cw721Activities: CW721Activity[];

  trackedCw721ContractsByAddr: Dictionary<CW721Contract>;

  constructor(
    tokens: Dictionary<CW721Token>,
    cw721Activities: CW721Activity[],
    trackedCw721ContractsByAddr: Dictionary<CW721Contract>
  ) {
    this.tokensKeyBy = tokens;
    this.cw721Activities = cw721Activities;
    this.trackedCw721ContractsByAddr = trackedCw721ContractsByAddr;
  }

  handlerCw721Transfer(transferMsg: SmartContractEvent) {
    const cw721Contract =
      this.trackedCw721ContractsByAddr[transferMsg.contractAddress];
    if (cw721Contract) {
      const recipient = getAttributeFrom(
        transferMsg.attributes,
        EventAttribute.ATTRIBUTE_KEY.RECIPIENT
      );
      const tokenId = getAttributeFrom(
        transferMsg.attributes,
        EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
      );
      const token =
        this.tokensKeyBy[`${transferMsg.contractAddress}_${tokenId}`];
      if (
        token !== undefined &&
        token.last_updated_height <= transferMsg.height
      ) {
        this.cw721Activities.push(
          CW721Activity.fromJson({
            action: transferMsg.action,
            sender: getAttributeFrom(
              transferMsg.attributes,
              EventAttribute.ATTRIBUTE_KEY.SENDER
            ),
            tx_hash: transferMsg.hash,
            cw721_contract_id: cw721Contract.id,
            height: transferMsg.height,
            smart_contract_event_id: transferMsg.smart_contract_event_id,
            from: token.owner,
            to: recipient,
            token_id: tokenId,
          })
        );
        token.owner = recipient;
        token.last_updated_height = transferMsg.height;
      }
    }
  }

  handlerCw721Mint(mintEvent: SmartContractEvent) {
    const cw721Contract =
      this.trackedCw721ContractsByAddr[mintEvent.contractAddress];
    if (cw721Contract) {
      const tokenId = getAttributeFrom(
        mintEvent.attributes,
        EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
      );
      const token = this.tokensKeyBy[`${mintEvent.contractAddress}_${tokenId}`];
      if (
        token === undefined ||
        token.last_updated_height <= mintEvent.height
      ) {
        const mediaInfo = null;
        this.tokensKeyBy[`${mintEvent.contractAddress}_${tokenId}`] =
          CW721Token.fromJson({
            token_id: tokenId,
            media_info: mediaInfo,
            owner: getAttributeFrom(
              mintEvent.attributes,
              EventAttribute.ATTRIBUTE_KEY.OWNER
            ),
            cw721_contract_id: cw721Contract.id,
            last_updated_height: mintEvent.height,
            burned: false,
            id: token === undefined ? undefined : token.id,
          });
        this.cw721Activities.push(
          CW721Activity.fromJson({
            action: mintEvent.action,
            sender: getAttributeFrom(
              mintEvent.attributes,
              EventAttribute.ATTRIBUTE_KEY.MINTER
            ),
            tx_hash: mintEvent.hash,
            cw721_contract_id: cw721Contract.id,
            height: mintEvent.height,
            smart_contract_event_id: mintEvent.smart_contract_event_id,
            from: null,
            to: getAttributeFrom(
              mintEvent.attributes,
              EventAttribute.ATTRIBUTE_KEY.OWNER
            ),
            token_id: tokenId,
          })
        );
      }
    }
  }

  handlerCw721Burn(burnMsg: SmartContractEvent) {
    const cw721Contract =
      this.trackedCw721ContractsByAddr[burnMsg.contractAddress];
    if (cw721Contract) {
      const tokenId = getAttributeFrom(
        burnMsg.attributes,
        EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
      );
      const token = this.tokensKeyBy[`${burnMsg.contractAddress}_${tokenId}`];
      if (token !== undefined && token.last_updated_height <= burnMsg.height) {
        this.cw721Activities.push(
          CW721Activity.fromJson({
            action: burnMsg.action,
            sender: getAttributeFrom(
              burnMsg.attributes,
              EventAttribute.ATTRIBUTE_KEY.SENDER
            ),
            tx_hash: burnMsg.hash,
            cw721_contract_id: cw721Contract.id,
            height: burnMsg.height,
            smart_contract_event_id: burnMsg.smart_contract_event_id,
            from: token.owner,
            to: null,
            token_id: tokenId,
          })
        );
        token.burned = true;
        token.last_updated_height = burnMsg.height;
      }
    }
  }

  handleCw721Others(msg: SmartContractEvent) {
    const cw721Contract = this.trackedCw721ContractsByAddr[msg.contractAddress];
    if (cw721Contract) {
      const tokenId = getAttributeFrom(
        msg.attributes,
        EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
      );
      this.cw721Activities.push(
        CW721Activity.fromJson({
          action: msg.action,
          sender: getAttributeFrom(
            msg.attributes,
            EventAttribute.ATTRIBUTE_KEY.SENDER
          ),
          tx_hash: msg.hash,
          cw721_contract_id: cw721Contract.id,
          height: msg.height,
          smart_contract_event_id: msg.smart_contract_event_id,
          token_id: tokenId,
        })
      );
    }
  }
}
