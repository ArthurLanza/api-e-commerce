import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const db = new DatabaseSync(process.env.LOJA_DB || 'loja.sqlite');

db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    precoCentavos INTEGER NOT NULL,
    estoque INTEGER NOT NULL CHECK (estoque >= 0)
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id TEXT PRIMARY KEY,
    totalCentavos INTEGER NOT NULL,
    itens TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repeticoes (
    chave TEXT PRIMARY KEY,
    assinatura TEXT NOT NULL,
    pedidoId TEXT NOT NULL
  );
`);

function falhar(status, mensagem) {
  throw Object.assign(new Error(mensagem), { status });
}

function inteiro(valor, minimo, maximo) {
  return Number.isInteger(valor) && valor >= minimo && valor <= maximo;
}

async function corpo(req) {
  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > 65536) {
      falhar(413, 'Corpo da requisição excede 64 KiB');
    }

    partes.push(parte);
  }

  let dados;

  try {
    dados = JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    falhar(400, 'JSON inválido');
  }

  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
    falhar(400, 'O corpo da requisição deve ser um objeto JSON');
  }

  return dados;
}

function criarProduto({ nome, precoCentavos, estoque }) {
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 150) {
    falhar(400, 'Informe um nome de até 150 caracteres');
  }

  if (!inteiro(precoCentavos, 1, 100000000)) {
    falhar(400, 'precoCentavos deve ser um inteiro entre 1 e 100000000');
  }

  if (!inteiro(estoque, 0, 1000000)) {
    falhar(400, 'estoque deve ser um inteiro entre 0 e 1000000');
  }

  return db.prepare(`
    INSERT INTO produtos (nome, precoCentavos, estoque)
    VALUES (?, ?, ?)
    RETURNING id, nome, precoCentavos, estoque
  `).get(nome.trim(), precoCentavos, estoque);
}

function buscarPedido(id) {
  const pedido = db.prepare(`
    SELECT id, totalCentavos, itens
    FROM pedidos
    WHERE id = ?
  `).get(id);

  if (!pedido) {
    falhar(404, 'Pedido inexistente');
  }

  return { ...pedido, itens: JSON.parse(pedido.itens) };
}

function criarPedido({ itens }, chave) {
  if (!Array.isArray(itens) || itens.length < 1 || itens.length > 100) {
    falhar(400, 'Envie de 1 a 100 itens');
  }

  if (chave !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(chave)) {
    falhar(400, 'Idempotency-Key inválida');
  }

  for (const item of itens) {
    if (!inteiro(item?.produtoId, 1, Number.MAX_SAFE_INTEGER)) {
      falhar(400, 'Cada item deve ter um produtoId válido');
    }

    if (!inteiro(item.quantidade, 1, 10000)) {
      falhar(400, 'A quantidade de cada item deve ser um inteiro entre 1 e 10000');
    }
  }

  // A ordem dos itens faz parte da assinatura do carrinho.
  const assinatura = JSON.stringify(
    itens.map(item => [item.produtoId, item.quantidade])
  );

  // A chave, o pedido e a baixa de estoque são confirmados na mesma transação.
  db.exec('BEGIN IMMEDIATE');

  try {
    if (chave !== undefined) {
      const anterior = db.prepare(`
        SELECT assinatura, pedidoId
        FROM repeticoes
        WHERE chave = ?
      `).get(chave);

      if (anterior) {
        if (anterior.assinatura !== assinatura) {
          falhar(409, 'Chave já usada em outro pedido');
        }

        const pedido = buscarPedido(anterior.pedidoId);
        db.exec('COMMIT');
        return { status: 200, pedido };
      }
    }

    const pedido = {
      id: randomUUID(),
      totalCentavos: 0,
      itens: []
    };

    const consultarProduto = db.prepare(`
      SELECT id, nome, precoCentavos, estoque
      FROM produtos
      WHERE id = ?
    `);

    const baixarEstoque = db.prepare(`
      UPDATE produtos
      SET estoque = estoque - ?
      WHERE id = ?
    `);

    for (const { produtoId, quantidade } of itens) {
      const produto = consultarProduto.get(produtoId);

      if (!produto) {
        falhar(404, 'Produto inexistente');
      }

      if (produto.estoque < quantidade) {
        falhar(409, `Estoque insuficiente para ${produto.nome}`);
      }

      baixarEstoque.run(quantidade, produtoId);

      // O pedido guarda o preço do catálogo no momento da compra.
      pedido.itens.push({
        produtoId,
        nome: produto.nome,
        precoCentavos: produto.precoCentavos,
        quantidade
      });

      pedido.totalCentavos += produto.precoCentavos * quantidade;
    }

    db.prepare(`
      INSERT INTO pedidos (id, totalCentavos, itens)
      VALUES (?, ?, ?)
    `).run(pedido.id, pedido.totalCentavos, JSON.stringify(pedido.itens));

    if (chave !== undefined) {
      db.prepare(`
        INSERT INTO repeticoes (chave, assinatura, pedidoId)
        VALUES (?, ?, ?)
      `).run(chave, assinatura, pedido.id);
    }

    db.exec('COMMIT');
    return { status: 201, pedido };
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}

const servidor = http.createServer(async (req, res) => {
  const rota = req.url.split('?')[0];

  function enviar(status, dados) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dados));
  }

  try {
    if (req.method === 'GET' && rota === '/produtos') {
      const produtos = db.prepare(`
        SELECT id, nome, precoCentavos, estoque
        FROM produtos
        ORDER BY id
      `).all();

      return enviar(200, produtos);
    }

    if (req.method === 'POST' && rota === '/produtos') {
      const dados = await corpo(req);
      return enviar(201, criarProduto(dados));
    }

    if (req.method === 'POST' && rota === '/pedidos') {
      const dados = await corpo(req);
      const chave = req.headers['idempotency-key'];
      const { status, pedido } = criarPedido(dados, chave);

      return enviar(status, pedido);
    }

    if (req.method === 'GET' && rota.startsWith('/pedidos/')) {
      const id = rota.slice('/pedidos/'.length);
      return enviar(200, buscarPedido(id));
    }

    falhar(404, 'Rota inexistente');
  } catch (erro) {
    if (!erro.status) {
      console.error(erro);
    }

    enviar(erro.status || 500, {
      erro: erro.status ? erro.message : 'Erro interno'
    });
  }
});

const porta = Number(process.env.PORT ?? 3000);

servidor.listen(porta, '127.0.0.1', () => {
  console.log(`API em http://127.0.0.1:${servidor.address().port}/produtos`);
});