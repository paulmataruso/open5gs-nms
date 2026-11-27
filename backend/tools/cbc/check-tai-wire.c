/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Read-only decoder for captures from the isolated CBC integration test. */
#include <stdio.h>
#include <assert.h>
#include <string.h>
#include <osmocom/sbcap/sbcap_common.h>

int main(int argc,char **argv)
{
    int kind,i;unsigned char expected[2][3]={{0x00,0xf1,0x10},{0x00,0x11,0x00}};
    assert(argc==3);
    for(kind=0;kind<2;kind++) {
        unsigned char buffer[4096];SBcAP_SBC_AP_PDU_t *pdu=NULL;SBcAP_List_of_TAIs_t *list=NULL;
        FILE *f=fopen(argv[kind+1],"rb");assert(f);size_t size=fread(buffer,1,sizeof(buffer),f);fclose(f);
        asn_dec_rval_t result=aper_decode_complete(NULL,&asn_DEF_SBcAP_SBC_AP_PDU,(void **)&pdu,buffer,size);
        assert(result.code==RC_OK && pdu && pdu->present==SBcAP_SBC_AP_PDU_PR_initiatingMessage);
        assert(pdu->choice.initiatingMessage.procedureCode==kind);
        if(!kind) {
            SBcAP_Write_Replace_Warning_Request_t *r=&pdu->choice.initiatingMessage.value.choice.Write_Replace_Warning_Request;
            for(i=0;i<r->protocolIEs.list.count;i++) {
                SBcAP_Write_Replace_Warning_Request_IEs_t *ie=r->protocolIEs.list.array[i];
                if(ie->id==14)list=&ie->value.choice.List_of_TAIs;
            }
        }else {
            SBcAP_Stop_Warning_Request_t *r=&pdu->choice.initiatingMessage.value.choice.Stop_Warning_Request;
            for(i=0;i<r->protocolIEs.list.count;i++) {
                SBcAP_Stop_Warning_Request_IEs_t *ie=r->protocolIEs.list.array[i];
                if(ie->id==14)list=&ie->value.choice.List_of_TAIs;
            }
        }
        assert(list && list->list.count==2);
        for(i=0;i<2;i++) {
            SBcAP_TAI_t *tai=&list->list.array[i]->tai;
            assert(tai->pLMNidentity.size==3 && !memcmp(tai->pLMNidentity.buf,expected[i],3));
            assert(tai->tAC.size==2 && ((tai->tAC.buf[0]<<8)|tai->tAC.buf[1])==(i?257:1));
        }
        ASN_STRUCT_FREE(asn_DEF_SBcAP_SBC_AP_PDU,pdu);
    }
    puts("CBC wire scope preserved on WRITE and STOP: both PLMN widths and TACs verified");
    return 0;
}
