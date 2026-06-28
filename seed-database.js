const pkg = require('pg');
const { Client } = pkg;
const dotenv = require('dotenv');

// Load environment config from backend .env
dotenv.config({ path: 'c:/Users/harsh/Desktop/Project/GarageKings/server/.env' });

const productsRaw = [
  { sku: 'GT852', brand: 'Mini GT', name: 'Marcedes-Benz 190 E', series: 'NA', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-20', purchasePrice: 1349, qtyPurchased: 1, qtySold: 1, sellingPrice: 2000 },
  { sku: 'GT1068', brand: 'Mini GT', name: 'Porsche 911 Dakar', series: 'NA', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-20', purchasePrice: 1499, qtyPurchased: 1, qtySold: 1, sellingPrice: 2000 },
  { sku: 'GT1105', brand: 'Mini GT', name: 'Bugatti Bolide', series: 'NA', scale: '1:64', color: 'Red', purchaseDate: '2026-05-20', purchasePrice: 1799, qtyPurchased: 1, qtySold: 1, sellingPrice: 2000 },
  { sku: 'GT999', brand: 'Mini GT', name: 'F1 Aston Martin AMR24', series: 'NA', scale: '1:64', color: 'Green', purchaseDate: '2026-05-20', purchasePrice: 1899, qtyPurchased: 1, qtySold: 1, sellingPrice: 2000 },
  { sku: 'GT1052', brand: 'Mini GT', name: 'Porsche 911 Roxy', series: 'NA', scale: '1:64', color: 'Pink', purchaseDate: '2026-05-20', purchasePrice: 1749, qtyPurchased: 3, qtySold: 3, sellingPrice: 3000 },
  { sku: 'HTHLH721', brand: 'Hotwheels', name: 'Volvo D50 Estate', series: 'Neon Speeders', scale: '1:64', color: 'White', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH722', brand: 'Hotwheels', name: 'Ford Firestone 20', series: 'Neon Speeders', scale: '1:64', color: 'Orange', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH723', brand: 'Hotwheels', name: '62 Corvette', series: 'Neon Speeders', scale: '1:64', color: 'Black', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH724', brand: 'Hotwheels', name: '64 Chevv Nova Glasser', series: 'Neon Speeders', scale: '1:64', color: 'Black', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH725', brand: 'Hotwheels', name: '70 Dodge Hemi Challenger', series: 'Neon Speeders', scale: '1:64', color: 'Green', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH726', brand: 'Hotwheels', name: 'Volkswagen SP2', series: 'Neon Speeders', scale: '1:64', color: 'Black', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH727', brand: 'Hotwheels', name: '85 Honda CR-X', series: 'Neon Speeders', scale: '1:64', color: 'Orange', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHLH728', brand: 'Hotwheels', name: 'Porsche 911', series: 'Neon Speeders', scale: '1:64', color: 'Pink', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 375 },
  { sku: 'HTHNR881', brand: 'Hotwheels', name: 'Nissan 350Z Custom', series: 'Silver Series', scale: '1:64', color: 'Black', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 1, sellingPrice: 360 },
  { sku: 'HTHNR882', brand: 'Hotwheels', name: 'Nissan Silvia (S15)', series: 'Silver Series', scale: '1:64', color: 'Blue', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 1, sellingPrice: 360 },
  { sku: 'HTHNR883', brand: 'Hotwheels', name: '1970 Monte Carlo', series: 'Silver Series', scale: '1:64', color: 'Cream', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 1, sellingPrice: 360 },
  { sku: 'HTHNR884', brand: 'Hotwheels', name: '1970 Road Runner', series: 'Silver Series', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 1, sellingPrice: 360 },
  { sku: 'HTHNR885', brand: 'Hotwheels', name: 'Nissan Silvia (S13)', series: 'Silver Series', scale: '1:64', color: 'Yellow', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 1, sellingPrice: 360 },
  { sku: 'HTDG891', brand: 'Hotwheels', name: 'Batcopter', series: 'Batman Silver Series', scale: '1:64', color: 'Green', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG892', brand: 'Hotwheels', name: 'The Dark Knight Batmobile', series: 'Batman Silver Series', scale: '1:64', color: 'White', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG893', brand: 'Hotwheels', name: 'Count Muscula', series: 'Batman Silver Series', scale: '1:64', color: 'Red', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG894', brand: 'Hotwheels', name: 'Hi-Roller II', series: 'Batman Silver Series', scale: '1:64', color: 'Purple', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG895', brand: 'Hotwheels', name: 'Boom Box', series: 'Batman Silver Series', scale: '1:64', color: 'Black', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG896', brand: 'Hotwheels', name: 'Batwing', series: 'Batman Silver Series', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG897', brand: 'Hotwheels', name: 'Speedbox', series: 'Batman Silver Series', scale: '1:64', color: 'Blue', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG898', brand: 'Hotwheels', name: 'Batmobile', series: 'Batman Silver Series', scale: '1:64', color: 'Grey', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG899', brand: 'Hotwheels', name: 'Prototype H-24', series: 'Batman Silver Series', scale: '1:64', color: 'Blue', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTDG8910', brand: 'Hotwheels', name: 'Jaded', series: 'Batman Silver Series', scale: '1:64', color: 'Green', purchaseDate: '2026-05-20', purchasePrice: 299, qtyPurchased: 1, qtySold: 0, sellingPrice: 360 },
  { sku: 'HTYT5688', brand: 'Hotwheels', name: 'Hype Hauler', series: 'Track Fleet', scale: '1:64', color: 'Grey', purchaseDate: '2026-05-20', purchasePrice: 550, qtyPurchased: 1, qtySold: 0, sellingPrice: 700 },
  { sku: 'HTYT5672', brand: 'Hotwheels', name: 'Bugcation', series: 'Track Fleet', scale: '1:64', color: 'White', purchaseDate: '2026-05-20', purchasePrice: 550, qtyPurchased: 1, qtySold: 0, sellingPrice: 700 },
  { sku: 'HTYT5630', brand: 'Hotwheels', name: 'Scania Rally Truck', series: 'Track Fleet', scale: '1:64', color: 'Blue', purchaseDate: '2026-05-20', purchasePrice: 550, qtyPurchased: 1, qtySold: 0, sellingPrice: 700 },
  { sku: 'HTYT56911', brand: 'Hotwheels', name: 'Porsche 911 Off Roader', series: 'Track Fleet', scale: '1:64', color: 'Cream', purchaseDate: '2026-05-20', purchasePrice: 550, qtyPurchased: 1, qtySold: 0, sellingPrice: 700 },
  { sku: 'HTMAINLINE', brand: 'Hotwheels', name: 'Mix Variety', series: 'Mainline', scale: '1:64', color: 'Multi', purchaseDate: '2026-05-20', purchasePrice: 179, qtyPurchased: 19, qtySold: 2, sellingPrice: 250 },
  { sku: 'GT1101', brand: 'Mini GT', name: 'LB-Super Silhouette', series: 'NA', scale: '1:64', color: 'Black', purchaseDate: '2026-05-31', purchasePrice: 1549, qtyPurchased: 1, qtySold: 0, sellingPrice: 2000 },
  { sku: 'GT1096', brand: 'Mini GT', name: 'Hyundai Ioniq 5N', series: 'NA', scale: '1:64', color: 'Black', purchaseDate: '2026-05-31', purchasePrice: 1600, qtyPurchased: 1, qtySold: 1, sellingPrice: 2000 },
  { sku: 'HTSS2', brand: 'Hotwheels', name: 'ZAMAC set of 6', series: 'Silver Series', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-31', purchasePrice: 2000, qtyPurchased: 1, qtySold: 0, sellingPrice: 3000 },
  { sku: 'HTSS1', brand: 'Hotwheels', name: 'MAZDA set of 6', series: 'Silver Series', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-31', purchasePrice: 2000, qtyPurchased: 1, qtySold: 1, sellingPrice: 3000 },
  { sku: 'GT910', brand: 'Mini GT', name: 'Aston Martin DB10 (Spectre 007)', series: 'NA', scale: '1:64', color: 'Silver', purchaseDate: '2026-05-31', purchasePrice: 1499, qtyPurchased: 3, qtySold: 3, sellingPrice: 1700 },
  { sku: 'GT1067', brand: 'Mini GT', name: 'Toyota Supra (A80)', series: 'NA', scale: '1:64', color: 'Purple', purchaseDate: '2026-05-31', purchasePrice: 1149, qtyPurchased: 2, qtySold: 2, sellingPrice: 1300 },
  { sku: 'SGWAGON', brand: 'Solido', name: 'G-Wagon', series: 'NA', scale: '1:32', color: 'White', purchaseDate: '2026-05-31', purchasePrice: 2600, qtyPurchased: 1, qtySold: 1, sellingPrice: 3000 },
  { sku: 'GTSUPRA', brand: 'Mini GT', name: 'Supra Pre Booking', series: 'F&F', scale: '1:64', color: 'Orange', purchaseDate: '2026-06-03', purchasePrice: 200, qtyPurchased: 24, qtySold: 11, sellingPrice: 200 },
  { sku: 'GT1160', brand: 'Mini GT', name: 'Nissan Skyline GT-R', series: 'NA', scale: '1:64', color: 'Silver', purchaseDate: '2026-06-04', purchasePrice: 1400, qtyPurchased: 2, qtySold: 2, sellingPrice: 2000 },
  { sku: 'HTFERRARI', brand: 'Hotwheels', name: 'Ferrari Pack of 5', series: 'NA', scale: '1:64', color: 'Red', purchaseDate: '2026-06-11', purchasePrice: 900, qtyPurchased: 1, qtySold: 1, sellingPrice: 1800 },
  { sku: 'HTRLC1', brand: 'Hotwheels', name: '1964 Jaguar', series: 'RLC', scale: '1:64', color: 'Red', purchaseDate: '2026-06-12', purchasePrice: 4700, qtyPurchased: 2, qtySold: 0, sellingPrice: 7000 },
  { sku: 'GTMUSTANG', brand: 'Mini GT', name: 'Red Mustang Pre Booking', series: 'NA', scale: '1:64', color: 'Red', purchaseDate: '2026-06-12', purchasePrice: 200, qtyPurchased: 12, qtySold: 1, sellingPrice: 200 },
  { sku: 'GT1144', brand: 'Mini GT', name: 'Range Rover 1981 Camel Trophy', series: 'NA', scale: '1:64', color: 'Yellow', purchaseDate: '2026-06-13', purchasePrice: 1549, qtyPurchased: 1, qtySold: 0, sellingPrice: 1900 },
  { sku: 'GT1118', brand: 'Mini GT', name: 'Toleman 1984 Monaco Grand Prix F1', series: 'NA', scale: '1:64', color: 'White', purchaseDate: '2026-06-13', purchasePrice: 1599, qtyPurchased: 1, qtySold: 1, sellingPrice: 1900 },
  { sku: 'GT1066', brand: 'Mini GT', name: 'Nissan Skyline GT-R (R32) VeilSide Combat', series: 'NA', scale: '1:64', color: 'White', purchaseDate: '2026-06-13', purchasePrice: 1299, qtyPurchased: 1, qtySold: 0, sellingPrice: 1600 },
  { sku: 'GT906', brand: 'Mini GT', name: 'BMW Z8 (007)', series: 'NA', scale: '1:64', color: 'Silver', purchaseDate: '2026-06-13', purchasePrice: 1599, qtyPurchased: 1, qtySold: 0, sellingPrice: 2000 },
  { sku: 'GT1166', brand: 'Mini GT', name: 'Ford Mustang Convertible 1964', series: 'NA', scale: '1:64', color: 'Green', purchaseDate: '2026-06-13', purchasePrice: 1399, qtyPurchased: 1, qtySold: 1, sellingPrice: 1700 },
  { sku: 'HTF1', brand: 'Hotwheels', name: 'F1 pack of 6', series: 'F1', scale: '1:64', color: 'Multi', purchaseDate: '2026-06-13', purchasePrice: 907, qtyPurchased: 1, qtySold: 0, sellingPrice: 1500 },
  { sku: 'GTMAZDA', brand: 'Mini GT', name: 'Mazda Pre Booking', series: 'F&F', scale: '1:64', color: 'Orange', purchaseDate: '2026-06-13', purchasePrice: 200, qtyPurchased: 0, qtySold: 2, sellingPrice: 200 },
  { sku: 'HTSS3', brand: 'Hotwheels', name: 'F&F Set of 5', series: 'Silver Series', scale: '1:64', color: 'Multi', purchaseDate: '2026-06-13', purchasePrice: 1495, qtyPurchased: 1, qtySold: 1, sellingPrice: 2000 },
  { sku: 'HTF1REDBULL', brand: 'Hotwheels', name: 'F1 Redbull', series: 'F1', scale: '1:64', color: 'Blue', purchaseDate: '2026-06-16', purchasePrice: 940, qtyPurchased: 1, qtySold: 1, sellingPrice: 1500 },
  { sku: 'CRVAN', brand: 'COOLCAR', name: 'VW T1 VAN', series: 'NA', scale: '1:64', color: 'Red', purchaseDate: '2026-06-16', purchasePrice: 300, qtyPurchased: 3, qtySold: 3, sellingPrice: 300 },
  { sku: 'GT1143', brand: 'Mini GT', name: 'Porche Skeleton Blister', series: 'NA', scale: '1:64', color: 'Black', purchaseDate: '2026-06-16', purchasePrice: 1952.33, qtyPurchased: 4, qtySold: 1, sellingPrice: 3000 },
  { sku: 'HTHRT81', brand: 'Hotwheels', name: '1968 Vintage club of 5', series: 'Silver Series', scale: '1:64', color: 'Multi', purchaseDate: '2026-06-17', purchasePrice: 1530, qtyPurchased: 4, qtySold: 2, sellingPrice: 2000 },
  { sku: 'HTGDG44', brand: 'Hotwheels', name: 'Performance Truck Set of 5', series: 'Silver Series', scale: '1:64', color: 'Multi', purchaseDate: '2026-06-17', purchasePrice: 1530, qtyPurchased: 1, qtySold: 0, sellingPrice: 2000 },
  { sku: 'GT1143B', brand: 'Mini GT', name: 'Porsche Skeleton Box', series: 'NA', scale: '1:64', color: 'Black', purchaseDate: '2026-06-17', purchasePrice: 1625, qtyPurchased: 4, qtySold: 1, sellingPrice: 2500 },
  { sku: 'GT1052', brand: 'Mini GT', name: 'Porsche 911 Roxy', series: 'NA', scale: '1:64', color: 'Pink', purchaseDate: '2026-06-17', purchasePrice: 2000, qtyPurchased: 3, qtySold: 1, sellingPrice: 3000 },
  { sku: 'GT3074', brand: 'Mini GT', name: 'Bugatti', series: 'NA', scale: '1:64', color: 'Black', purchaseDate: '2026-06-17', purchasePrice: 1800, qtyPurchased: 1, qtySold: 0, sellingPrice: 10000 },
  { sku: 'FLROXY', brand: 'Flame', name: 'Roxy', series: 'NA', scale: '1:64', color: 'Pink', purchaseDate: '2026-06-19', purchasePrice: 3130, qtyPurchased: 1, qtySold: 0, sellingPrice: 6160 },
  { sku: 'FLREXY', brand: 'Flame', name: 'Rexy', series: 'NA', scale: '1:64', color: 'Green', purchaseDate: '2026-06-19', purchasePrice: 3130, qtyPurchased: 1, qtySold: 0, sellingPrice: 6160 },
  { sku: 'HTFPY861', brand: 'Hotwheels', name: 'Nissan Z GT4', series: 'Car Culture', scale: '1:64', color: 'White', purchaseDate: '2026-06-19', purchasePrice: 1700, qtyPurchased: 1, qtySold: 0, sellingPrice: 3500 },
  { sku: 'HTFPY862', brand: 'Hotwheels', name: 'Mazda RX7 FC Pandem', series: 'Car Culture', scale: '1:64', color: 'Multi', purchaseDate: '2026-06-19', purchasePrice: 1700, qtyPurchased: 1, qtySold: 0, sellingPrice: 3500 },
  { sku: 'GT952', brand: 'Mini GT', name: 'BMW i7', series: 'NA', scale: '1:64', color: 'Red', purchaseDate: '2026-06-19', purchasePrice: 1400, qtyPurchased: 1, qtySold: 0, sellingPrice: 1800 },
  { sku: 'GT993', brand: 'Mini GT', name: 'McLaren 720S GT3 EVO', series: 'NA', scale: '1:64', color: 'White', purchaseDate: '2026-06-22', purchasePrice: 2650, qtyPurchased: 1, qtySold: 0, sellingPrice: 3000 },
  { sku: 'HTHXD631', brand: 'Hotwheels', name: 'MTV 84 Corvette', series: 'Pop Culture', scale: '1:64', color: 'White', purchaseDate: '2026-06-22', purchasePrice: 633, qtyPurchased: 1, qtySold: 0, sellingPrice: 1100 },
  { sku: 'HTHXD632', brand: 'Hotwheels', name: 'Deadpool Scooter', series: 'Pop Culture', scale: '1:64', color: 'Red', purchaseDate: '2026-06-22', purchasePrice: 633, qtyPurchased: 1, qtySold: 0, sellingPrice: 1100 },
  { sku: 'HYFPY6', brand: 'Hotwheels', name: 'Aston Martin Vintage GTE', series: 'Car Culture', scale: '1:64', color: 'White', purchaseDate: '2026-06-22', purchasePrice: 633, qtyPurchased: 1, qtySold: 0, sellingPrice: 1100 }
];

const ordersRaw = [
  { orderId: 'RT0001', customerName: 'Praveen Pandian', phone: '8925537980', address: 'No. 8/19, Ganga Street Rajaji Nagar, Villivakkam, Chennai - 600049', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-05-28', type: 'Pre-Booking' },
  { orderId: 'RT0002', customerName: 'Ajith Siva', phone: '6380678225', address: '105 Sri Bhairaveshwara Nilaya, Near Ksvk School, beside Little Angels Play Home Vinayaka Layout, Whitefield, Karnataka - 560066', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-05-28', type: 'Pre-Booking' },
  { orderId: 'RT0005', customerName: 'Rasesh Talati', phone: '9819169632', address: '3A sagar vihar 45 k munshi marg, Opposite merchants club, Inside bhavans college lane, Girgaon Chowpatty, Mumbai 400007', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-05-30', type: 'Pre-Booking' },
  { orderId: 'RT00010', customerName: 'Gowthaman Ravi', phone: '9791604061', address: 'No 26, NJK Sastha Sadhanam, Tata pipeline road, Ayyappankavu, Ernakulam-682018 Kerala', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-03', type: 'Pre-Booking' },
  { orderId: 'RT00012', customerName: 'Akshat Goel', phone: 'NA', address: 'Bhiwadi', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Anish', date: '2026-06-05', type: 'Pre-Booking' },
  { orderId: 'RT00014', customerName: 'Ansh Arora', phone: '7703813453', address: 'Address- B-252, Sector-71, Noida, Uttar Pradesh 201301', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-08', type: 'Pre-Booking' },
  { orderId: 'RT00015', customerName: 'Ompalsinh Parmar', phone: '9924103344', address: 'Shop no 3, Jalaram auto spare, opposite renbasera hotel, near valsadi zampa, killa pardi, PIN code - 396125', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-11', type: 'Pre-Booking' },
  { orderId: 'RT00019', customerName: 'Ompalsinh Parmar', phone: '9924103344', address: 'Shop no 3, Jalaram auto spare, opposite renbasera hotel, near valsadi zampa, killa pardi, PIN code - 396125', skus: 'GTMUSTANG', paid: 300, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-12', type: 'Pre-Booking' },
  { orderId: 'RT00023', customerName: 'Nihaal Joseph Skariah', phone: '9620756088', address: '695, ex-servicemen colony, Dodda Banaswadi, Bangalore 560043', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-14', type: 'Pre-Booking' },
  { orderId: 'RT00024', customerName: 'Nihaal Joseph Skariah', phone: '9620756088', address: '695, ex-servicemen colony, Dodda Banaswadi, Bangalore 560043', skus: 'GTMAZDA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-14', type: 'Pre-Booking' },
  { orderId: 'RT00025', customerName: 'Dakshith S', phone: '7019177628', address: '#39 10th main muthyalnagar bangalore 560054', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-15', type: 'Pre-Booking' },
  { orderId: 'RT00028', customerName: 'Ompalsinh Parmar', phone: '9924103344', address: 'Shop no 3, Jalaram auto spare, opposite renbasera hotel, near valsadi zampa, killa pardi, PIN code - 396125', skus: 'CRVAN', paid: 300, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-16', type: 'Pre-Booking' },
  { orderId: 'RT00029', customerName: 'Sanchit Jain', phone: '9255543449', address: 'Rewari', skus: 'HTMAINLINE', paid: 200, status: 'In Process', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-17', type: 'Order' },
  { orderId: 'RT00030', customerName: 'Ompalsinh Parmar', phone: '9924103344', address: 'Shop no 3, Jalaram auto spare, opposite renbasera hotel, near valsadi zampa, killa pardi, PIN code - 396125', skus: 'GTMAZDA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-17', type: 'Pre-Booking' },
  { orderId: 'RT00031', customerName: 'Jonah Daniel', phone: '8431886049', address: '#28/7, St Thomas Town, Ramaiah Layout,Kammanhalli,Bangalore-560084', skus: 'CRVAN, CRVAN', paid: 500, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-17', type: 'Pre-Booking' },
  { orderId: 'RT00033', customerName: 'Karan Gupta', phone: 'NA', address: 'Bhiwadi', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-19', type: 'Pre-Booking' },
  { orderId: 'RT00035', customerName: 'Ompalsinh Parmar', phone: '9924103344', address: 'Shop no 3, Jalaram auto spare, opposite renbasera hotel, near valsadi zampa, killa pardi, PIN code - 396125', skus: 'HTHRT81', paid: 2200, status: 'Done', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-20', type: 'Order' },
  { orderId: 'RT00036', customerName: 'Mohan', phone: '7737734466', address: '13/5, Arunachal Home Sadasivam Street, Gopalalpuram, Chennai - 600086', skus: 'GT1118, GT1166, HTHRT81', paid: 5800, status: 'Done', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-24', type: 'Order' },
  { orderId: 'RT00037', customerName: 'Sahil Pawar', phone: '7400492404', address: 'Ruparel Ariana 57TH FLOOR, 5704, Jerbai Wadia Road, Dadar Naigaon Cross-Road, Parel, Mumbai - 400015', skus: 'GT1143B', paid: 2700, status: 'In Process', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-24', type: 'Order' },
  { orderId: 'RT00038', customerName: 'Pradyumna v', phone: '7299945270', address: 'apt number :26185 building 2 tower 6, Prestige Jindal City , tumkur main road , 7th cross street , manjunath nagar, Bengaluru - 560073', skus: 'GT1052', paid: 3200, status: 'In Process', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-25', type: 'Order' },
  { orderId: 'RT00039', customerName: 'Ragul Jayakumar Doodle', phone: '9176039000', address: 'No: 11/1 , Gandhi Nagar Main Road, Palavakkam, Chennai - 600041', skus: 'GTSUPRA', paid: 200, status: 'Pending', receipt: 'Done', paidTo: 'Sanchit', date: '2026-06-25', type: 'Pre-Booking' }
];

const expensesRaw = [
  { title: 'Bubble Wrap', paidBy: 'Anish', amount: 123, settled: true },
  { title: 'Stickers and Packaging', paidBy: 'Anish', amount: 500, settled: true },
  { title: 'Print And Stand', paidBy: 'Anish', amount: 600, settled: true },
  { title: 'Marketing', paidBy: 'Harshal', amount: 910, settled: false },
  { title: 'Shiprocket', paidBy: 'Anish', amount: 1000, settled: true },
  { title: 'Packaging', paidBy: 'Anish', amount: 356, settled: true },
  { title: 'Marketing', paidBy: 'Harshal', amount: 1000, settled: true },
  { title: 'Delivery', paidBy: 'Anish', amount: 620, settled: true },
  { title: 'Bubble wrap', paidBy: 'Anish', amount: 200, settled: true },
  { title: 'Marketing', paidBy: 'Sanchit', amount: 420, settled: true },
  { title: 'Marketing', paidBy: 'Harshal', amount: 1000, settled: true },
  { title: 'Shipping', paidBy: 'Anish', amount: 120, settled: true },
  { title: 'Shipping', paidBy: 'Anish', amount: 150, settled: true },
  { title: 'Marketing', paidBy: 'Harshal', amount: 2000, settled: true },
  { title: 'Marketing', paidBy: 'Harshal', amount: 2000, settled: true },
  { title: 'Website', paidBy: 'Harshal', amount: 1235, settled: true },
  { title: 'Shipping & Box', paidBy: 'Anish', amount: 550, settled: true },
  { title: 'Shipping', paidBy: 'Anish', amount: 130, settled: true },
  { title: 'Marketing', paidBy: 'Harshal', amount: 2000, settled: true },
  { title: 'Transparent case', paidBy: 'Anish', amount: 625, settled: true }
];

async function seed() {
  console.log("Starting database seeding from raw PDF metrics...");
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  console.log("✔ Connected to database successfully.");

  // Clear tables first (using TRUNCATE CASCADE to clear everything cleanly)
  console.log("Clearing existing tables...");
  await client.query(`
    TRUNCATE TABLE 
      expenses, 
      order_items, 
      orders, 
      inventory_transactions, 
      inventory, 
      product_images, 
      products, 
      customers, 
      profiles, 
      users,
      system_notifications,
      split_settlements
    RESTART IDENTITY CASCADE;
  `);
  console.log("✔ Database tables cleared.");

  // 1. Seed Founders as Admin Users
  console.log("Seeding admin founders...");
  const founders = [
    { email: 'harshalgadhe123@gmail.com', name: 'Harshal', cognito: '7113cdfa-d021-7082-178e-ec3f8ff840c4' },
    { email: 'anutosh@garagekings.com', name: 'Anutosh', cognito: 'cognito-sub-anutosh' },
    { email: 'sanchit@garagekings.com', name: 'Sanchit', cognito: 'cognito-sub-sanchit' },
    { email: 'anish@garagekings.com', name: 'Anish', cognito: 'cognito-sub-anish' }
  ];

  const founderIdsMap = {};

  for (const f of founders) {
    const userRes = await client.query(`
      INSERT INTO users (email, role, cognito_sub)
      VALUES ($1, 'Owner', $2)
      RETURNING id;
    `, [f.email, f.cognito]);
    const userId = userRes.rows[0].id;
    founderIdsMap[f.name] = userId;

    await client.query(`
      INSERT INTO profiles (user_id, username, display_name, avatar_url)
      VALUES ($1, $2, $3, $4);
    `, [userId, f.name.toLowerCase(), f.name, `https://ui-avatars.com/api/?name=${f.name}&background=ff5500&color=fff`]);
  }
  console.log("✔ Seeding of admin founders completed.");

  // 2. Merge and Seed Products (Page 1)
  console.log("Merging and seeding products catalog...");
  
  const mergedProducts = {};
  for (const p of productsRaw) {
    if (mergedProducts[p.sku]) {
      mergedProducts[p.sku].totalStock += p.qtyPurchased;
      mergedProducts[p.sku].soldStock += p.qtySold;
      // Keep the latest purchase price and selling price
      mergedProducts[p.sku].purchasePrice = p.purchasePrice;
      mergedProducts[p.sku].price = p.sellingPrice;
    } else {
      mergedProducts[p.sku] = {
        sku: p.sku,
        brand: p.brand,
        name: p.name,
        series: p.series,
        scale: p.scale,
        color: p.color,
        purchasePrice: p.purchasePrice,
        price: p.sellingPrice,
        totalStock: p.qtyPurchased,
        soldStock: p.qtySold,
        lane: p.series === 'NA' ? 'Standard Edition' : p.series,
        category: p.brand === 'Hotwheels' ? 'Mainline' : 'JDM',
        tags: p.series !== 'NA' ? [p.series] : []
      };
    }
  }

  const productIdsMap = {};

  for (const sku of Object.keys(mergedProducts)) {
    const p = mergedProducts[sku];
    
    // Insert product
    const prodRes = await client.query(`
      INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description, tags, category, purchase_price, selling_price, total_stock, sold_stock, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Published')
      RETURNING id;
    `, [
      p.sku,
      p.brand,
      p.name,
      p.series,
      p.scale,
      p.lane,
      Number(p.price),
      `Premium highly-detailed die-cast scale model. Color Variant: ${p.color}.`,
      p.tags,
      p.category,
      Number(p.purchasePrice),
      Number(p.price),
      Number(p.totalStock),
      Number(p.soldStock)
    ]);
    const productId = prodRes.rows[0].id;
    productIdsMap[sku] = productId;

    // Seed primary image
    await client.query(`
      INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
      VALUES ($1, '/placeholder-car.png', '/placeholder-car.png', '/placeholder-car.png', true);
    `, [productId]);

    // Seed inventory stock record
    const quantityAvailable = Math.max(0, Number(p.totalStock) - Number(p.soldStock));
    await client.query(`
      INSERT INTO inventory (product_id, quantity_available, quantity_reserved)
      VALUES ($1, $2, 0);
    `, [productId, quantityAvailable]);
  }
  console.log(`✔ Seeding of ${Object.keys(mergedProducts).length} products completed.`);

  // 3. Seed Customers & Orders (Page 2)
  console.log("Seeding customers and orders...");
  
  const customerEmailsMap = {};

  for (const order of ordersRaw) {
    let mockEmail = customerEmailsMap[order.customerName];
    let userId;

    if (!mockEmail) {
      mockEmail = order.customerName.toLowerCase().replace(/[^a-z0-9]/g, '') + '@mock.com';
      customerEmailsMap[order.customerName] = mockEmail;

      // Create user
      const userRes = await client.query(`
        INSERT INTO users (email, role)
        VALUES ($1, 'Viewer')
        RETURNING id;
      `, [mockEmail]);
      userId = userRes.rows[0].id;

      // Create customer CRM
      await client.query(`
        INSERT INTO customers (full_name, phone, address, email, city)
        VALUES ($1, $2, $3, $4, $5);
      `, [
        order.customerName,
        order.phone === 'NA' ? null : order.phone,
        order.address,
        mockEmail,
        order.address.split(',').pop().trim() // extract rough city from last part of address
      ]);

      // Create user profile
      await client.query(`
        INSERT INTO profiles (user_id, username, display_name)
        VALUES ($1, $2, $3);
      `, [userId, order.customerName.toLowerCase().replace(/[^a-z0-9]/g, ''), order.customerName]);
    } else {
      // Look up user id by email
      const userRes = await client.query(`SELECT id FROM users WHERE email = $1`, [mockEmail]);
      userId = userRes.rows[0].id;
    }

    // Map Page 2 Status to enum
    let dbStatus = 'Pending';
    if (order.status === 'In Process') {
      dbStatus = 'Confirmed';
    } else if (order.status === 'Done') {
      dbStatus = 'Delivered';
    }

    // Insert order
    const orderRes = await client.query(`
      INSERT INTO orders (user_id, total_price, shipping_address, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $5)
      RETURNING id;
    `, [
      userId,
      Number(order.paid),
      order.address,
      dbStatus,
      new Date(order.date)
    ]);
    const orderId = orderRes.rows[0].id;

    // Parse items (comma-separated SKUs)
    const skusList = order.skus.split(',').map(s => s.trim());
    
    // Count quantities per SKU in this order
    const skuCounts = {};
    for (const s of skusList) {
      skuCounts[s] = (skuCounts[s] || 0) + 1;
    }

    let productsCostSum = 0;
    const itemsToInsert = [];

    for (const s of Object.keys(skuCounts)) {
      const prodId = productIdsMap[s];
      if (!prodId) {
        console.warn(`⚠️ Warning: SKU ${s} not found in productIdsMap during order ${order.orderId} seeding!`);
        continue;
      }
      
      const prodRes = await client.query(`SELECT base_price, model_name FROM products WHERE id = $1`, [prodId]);
      const basePrice = Number(prodRes.rows[0]?.base_price || 0);
      const name = prodRes.rows[0]?.model_name || '';
      
      productsCostSum += basePrice * skuCounts[s];
      itemsToInsert.push({
        prodId,
        sku: s,
        name,
        qty: skuCounts[s],
        price: basePrice
      });
    }

    for (const item of itemsToInsert) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
        VALUES ($1, $2, $3, $4);
      `, [
        orderId,
        item.prodId,
        item.qty,
        item.price
      ]);
    }

    // Look up customer id by email
    const custRes = await client.query(`SELECT id FROM customers WHERE email = $1`, [mockEmail]);
    const customerId = custRes.rows[0].id;

    if (order.receipt === 'Done') {
      const shippingCharges = Math.max(0, Number(order.paid) - productsCostSum);
      const totalAmount = Number(order.paid);
      
      const receiptRes = await client.query(`
        INSERT INTO receipts (
          receipt_number, customer_id, format_type, tax_percent, tax_amount, 
          shipping_charges, total_amount, advance_paid, pending_balance, footer_note,
          customer_name, customer_phone, customer_address
        )
        VALUES ($1, $2, 'standard', 0.00, 0.00, $3, $4, $4, 0.00, $5, $6, $7, $8)
        RETURNING id;
      `, [
        order.orderId,
        customerId,
        shippingCharges,
        totalAmount,
        'In the event that the order cannot be fulfilled from our end, a full refund will be issued.',
        order.customerName,
        order.phone === 'NA' ? null : order.phone,
        order.address
      ]);
      
      const receiptId = receiptRes.rows[0].id;
      
      for (const item of itemsToInsert) {
        await client.query(`
          INSERT INTO receipt_items (receipt_id, description, qty, amount)
          VALUES ($1, $2, $3, $4);
        `, [
          receiptId,
          `${item.name} - ${item.sku}`,
          item.qty,
          item.price
        ]);
      }

      if (shippingCharges > 0) {
        await client.query(`
          INSERT INTO receipt_items (receipt_id, description, qty, amount)
          VALUES ($1, 'Shipping Charges', 1, $2);
        `, [receiptId, shippingCharges]);
      }

      const generatedPdfUrl = `https://gk-public-assets.s3.ap-south-1.amazonaws.com/receipts/${order.orderId}.pdf`;
      await client.query(`
        INSERT INTO receipt_generation_jobs (receipt_id, status, pdf_s3_url)
        VALUES ($1, 'Completed', $2);
      `, [receiptId, generatedPdfUrl]);

      await client.query(`
        UPDATE receipts SET pdf_url = $1 WHERE id = $2;
      `, [generatedPdfUrl, receiptId]);
    }
  }
  console.log(`✔ Seeding of ${ordersRaw.length} orders completed.`);

  // 4. Seed Expenses (Page 3)
  console.log("Seeding expenses...");
  
  for (const exp of expensesRaw) {
    await client.query(`
      INSERT INTO expenses (title, amount, category, paid_by, date, notes)
      VALUES ($1, $2, $3, $4, '2026-06-15', 'Imported from spreadsheet data');
    `, [
      exp.title,
      Number(exp.amount),
      exp.title.toLowerCase().includes('shipping') || exp.title.toLowerCase().includes('delivery') || exp.title.toLowerCase().includes('shiprocket') ? 'Shipping' :
      exp.title.toLowerCase().includes('wrap') || exp.title.toLowerCase().includes('packaging') || exp.title.toLowerCase().includes('box') || exp.title.toLowerCase().includes('case') ? 'Packaging' :
      exp.title.toLowerCase().includes('marketing') ? 'Marketing' :
      exp.title.toLowerCase().includes('website') || exp.title.toLowerCase().includes('stand') ? 'Operations' : 'Other',
      exp.paidBy,
    ]);
  }
  console.log(`✔ Seeding of ${expensesRaw.length} expenses completed.`);

  await client.end();
  console.log("==================================================");
  console.log("✔ DATABASE SEEDING COMPLETED SUCCESSFULLY!");
  console.log("==================================================");
}

seed().catch(err => {
  console.error("❌ Seeding failed!", err);
  process.exit(1);
});
