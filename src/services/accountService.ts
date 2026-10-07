import * as accountsRepository from
  "../data/accountsReposity.js";

export async function getAccounts(
  tenantId: string,
) {
  return accountsRepository.findActiveByTenant(
    tenantId,
  );
}
