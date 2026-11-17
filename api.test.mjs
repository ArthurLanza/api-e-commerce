import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

let servidor, url;
before(async () => {
  servidor = spawn(process.execPath, [fileURLToPath(new URL('./api.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', LOJA_DB: ':memory:' }
  });
  const [linha] = await once(servidor.stdout, 'data');
  url = new URL(linha.toString().trim().split(' ')[2]).origin;
});
after(async () => {
  if (servidor.exitCode === null) {
    const saida = once(servidor, 'exit');
    servidor.kill();
    await saida;
  }
});

async function post(rota, dados, chave) {
  const headers = { 'Content-Type': 'application/json' };
  if (chave) headers['Idempotency-Key'] = chave;
  return fetch(url + rota, { method: 'POST', headers, body: JSON.stringify(dados) });
}
async function produto() {
  const resposta = await post('/produtos', { nome: 'Camiseta', estoque: 5, precoCentavos: 7990 });
  assert.equal(resposta.status, 201);
  return resposta.json();
}
async function estoque(id) {
  const produtos = await (await fetch(url + '/produtos')).json();
  return produtos.find(p => p.id === id).estoque;
}
test('estoque insuficiente no segundo item desfaz a compra inteira', async () => {
  const { id } = await produto();
  const item = { produtoId: id, quantidade: 3 };
  const resposta = await post('/pedidos', { itens: [item, item] });
  assert.equal(resposta.status, 409);
  // Se a primeira baixa tivesse sido mantida, sobrariam apenas 2 unidades.
  assert.equal(await estoque(id), 5);
});
test('dois envios simultâneos com a mesma chave geram uma única compra', async () => {
  const { id } = await produto();
  const carrinho = { itens: [{ produtoId: id, quantidade: 2 }] };
  const enviar = () => post('/pedidos', carrinho, 'compra-1');
  const respostas = await Promise.all([enviar(), enviar()]);
  assert.deepEqual(respostas.map(r => r.status).sort(), [200, 201]);
  const [a, b] = await Promise.all(respostas.map(r => r.json()));
  assert.deepEqual(a, b);
  assert.equal(a.totalCentavos, 15980);
  assert.deepEqual(await (await fetch(url + '/pedidos/' + a.id)).json(), a);
  assert.equal(await estoque(id), 3);
  carrinho.itens[0].quantidade = 1;
  assert.equal((await enviar()).status, 409);
  assert.equal(await estoque(id), 3);
});
