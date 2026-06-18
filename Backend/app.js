require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 5000;

function requiredEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required. Set it in Backend/.env locally or in the Kubernetes manifest (env / secret).`);
  }
  return process.env[name];
}

// Allow frontend to call this API
app.use(cors());
app.use(express.json());

const seedProducts = [
  { id: 1, name: 'Wireless Headphones', category: 'Electronics', price: 2999, stock: 45 },
  { id: 2, name: 'Running Shoes',       category: 'Sports',      price: 1499, stock: 120 },
  { id: 3, name: 'Coffee Maker',        category: 'Kitchen',     price: 3499, stock: 30 },
  { id: 4, name: 'Yoga Mat',            category: 'Sports',      price: 799,  stock: 200 },
  { id: 5, name: 'Desk Lamp',           category: 'Home',        price: 599,  stock: 80 },
  { id: 6, name: 'Bluetooth Speaker',   category: 'Electronics', price: 1999, stock: 60 },
];

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASSWORD'),
  database: process.env.DB_NAME || 'product_catalog',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      price INT NOT NULL,
      stock INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM products');
  if (count === 0) {
    await db.query(
      'INSERT INTO products (id, name, category, price, stock) VALUES ?',
      [seedProducts.map(product => [
        product.id,
        product.name,
        product.category,
        product.price,
        product.stock,
      ])],
    );
  }
}

// Health check
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', service: 'backend', database: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', service: 'backend', database: 'unreachable', detail: err.message });
  }
});

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const [products] = await db.query('SELECT id, name, category, price, stock FROM products ORDER BY id');
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch products', detail: err.message });
  }
});

// Get single product by ID
app.get('/api/products/:id', async (req, res) => {
  try {
    const [products] = await db.query(
      'SELECT id, name, category, price, stock FROM products WHERE id = ?',
      [req.params.id],
    );
    if (products.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, data: products[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch product', detail: err.message });
  }
});

// Add a new product
app.post('/api/products', async (req, res) => {
  const { name, category, price, stock } = req.body;
  if (!name || !category || !price) {
    return res.status(400).json({ success: false, message: 'name, category and price are required' });
  }

  try {
    const productPrice = parseInt(price, 10);
    const productStock = parseInt(stock, 10) || 0;
    const [result] = await db.query(
      'INSERT INTO products (name, category, price, stock) VALUES (?, ?, ?, ?)',
      [name, category, productPrice, productStock],
    );
    res.status(201).json({
      success: true,
      data: { id: result.insertId, name, category, price: productPrice, stock: productStock },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create product', detail: err.message });
  }
});

// Delete a product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete product', detail: err.message });
  }
});

// Start server
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log('Backend API running on http://localhost:' + PORT);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
