# API de e-commerce
Projeto local em Node.js 24 e SQLite. Abra esta pasta no terminal e execute `node api.mjs`. O banco loja.sqlite é criado automaticamente. Use Ctrl+C para parar.

## Primeira compra no PowerShell
Com o servidor ligado, abra outro PowerShell e execute:
```powershell
$url = 'http://127.0.0.1:3000'
$p = Invoke-RestMethod "$url/produtos" -Method Post -ContentType 'application/json' -Body '{"nome":"Camiseta","precoCentavos":7990,"estoque":5}'
$body = @{ itens = @(@{ produtoId = $p.id; quantidade = 2 }) } | ConvertTo-Json -Depth 4
$pedido = Invoke-RestMethod "$url/pedidos" -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod "$url/pedidos/$($pedido.id)"
Invoke-RestMethod "$url/produtos"
```
O pedido soma 15980 centavos e restam 3 camisetas. Cada novo cadastro cria um produto. O preço é lido do catálogo. Uma falha em qualquer item desfaz a compra inteira. Cada POST de pedido bem-sucedido gera uma nova compra.

Este projeto roda na sua máquina. Cadastro de usuários, autenticação, frete e pagamento ficam fora desta versão.
