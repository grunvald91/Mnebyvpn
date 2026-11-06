/** Durable payment incident alert outbox.
 * Never includes tokens, invoice payloads, IP addresses or full transaction IDs.
 * The database retains pending alerts when Telegram is unreachable.
 */
import type {PgBillingStore} from './store.ts';
export interface IncidentAlertSender {
  sendMessage(chatId:number,text:string):Promise<unknown>;
}
export async function deliverPaymentIncidentAlerts(
  db:Pick<PgBillingStore,'pendingPaymentIncidentAlerts'|'markPaymentIncidentAlerted'>,
  sender:IncidentAlertSender,operatorChatId:number,max=20,
):Promise<number>{
  if(!Number.isSafeInteger(operatorChatId)||operatorChatId<=0)
    throw new Error('Operator Telegram chat id required');
  const pending=await db.pendingPaymentIncidentAlerts(max);
  let delivered=0;
  for(const incident of pending){
    const text='🚨 MNEBYVPN: не сопоставлен подтверждённый платёж #'+incident.id+
      '\nИсточник: '+incident.provider+'\nПричина: '+incident.reason+
      '\nСумма: '+(incident.amount===null?'неизвестна':String(incident.amount))+
      ' '+(incident.currency??'')+
      '\nНужна ручная проверка поступления и возврата.';
    await sender.sendMessage(operatorChatId,text);
    await db.markPaymentIncidentAlerted(incident.id);
    delivered++;
  }
  return delivered;
}
