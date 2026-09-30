import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

const CHATS_DATA = [
  {
    id: '1',
    name: 'Sarah Jenkins',
    message: 'Awesome, see you soon!',
    time: '11:47 AM',
    unread: 2,
    color: '#4A90E2',
  },
  {
    id: '2',
    name: 'Product Squad',
    message: 'Wireframes have been uploaded.',
    time: '10:30 AM',
    unread: 5,
    color: '#9B51E0',
  },
  {
    id: '3',
    name: 'Michael Chen',
    message: 'See you there in an hour 👍',
    time: '9:15 AM',
    unread: 0,
    color: '#27AE60',
  },
  {
    id: '4',
    name: 'Mom',
    message: 'Call me when you are free',
    time: 'Yesterday',
    unread: 0,
    color: '#EB5757',
  },
  {
    id: '5',
    name: 'Football Group',
    message: 'Match is on for Sunday 6 PM',
    time: 'Yesterday',
    unread: 0,
    color: '#F2994A',
  },
  {
    id: '6',
    name: 'David Miller',
    message: 'Can you send over the presentation?',
    time: 'Tuesday',
    unread: 0,
    color: '#2D9CDB',
  },
  {
    id: '7',
    name: 'Emily Watson',
    message: 'Thanks for the help earlier!',
    time: '26/09',
    unread: 0,
    color: '#6FCF97',
  },
];

export default function App() {
  const [search, setSearch] = useState('');

  const filteredChats = CHATS_DATA.filter(
    (item) =>
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.message.toLowerCase().includes(search.toLowerCase())
  );

  const renderItem = ({ item }) => {
    const initial = item.name.charAt(0).toUpperCase();

    return (
      <TouchableOpacity style={styles.chatItem} activeOpacity={0.6}>
        {/* Avatar with first letter */}
        <View style={[styles.avatar, { backgroundColor: item.color }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>

        {/* Info */}
        <View style={styles.chatInfo}>
          <View style={styles.rowTop}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.time}>{item.time}</Text>
          </View>

          <View style={styles.rowBottom}>
            <Text style={styles.message} numberOfLines={1}>
              {item.message}
            </Text>
            {item.unread > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.unread}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />

        {/* Simple Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Chats</Text>
        </View>

        {/* Basic Search Input */}
        <View style={styles.searchWrapper}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search..."
            placeholderTextColor="#999"
            value={search}
            onChangeText={setSearchQuery => setSearch(setSearchQuery)}
          />
        </View>

        {/* Chat List */}
        <FlatList
          data={filteredChats}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.list}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#111',
  },
  searchWrapper: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  searchInput: {
    backgroundColor: '#f1f1f1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  list: {
    paddingTop: 4,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  chatInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
  },
  time: {
    fontSize: 12,
    color: '#888',
  },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  message: {
    fontSize: 14,
    color: '#666',
    flex: 1,
    marginRight: 8,
  },
  badge: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  separator: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginLeft: 74,
  },
});
